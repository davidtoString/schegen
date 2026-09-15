const axios = require('axios');
const cheerio = require('cheerio');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  processEntities: false,
  ignoreAttributes: false,
  attributeNamePrefix: '@_'
});

/**
 * Get browser-like headers for sitemap requests
 */
function getSitemapHeaders(url) {
  const urlObj = new URL(url);
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/xml,application/xml,text/html,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Referer': `${urlObj.protocol}//${urlObj.host}/`
  };
}

/**
 * Check if a sitemap URL matches the post type filter
 * WordPress sitemaps typically named: post-sitemap.xml, page-sitemap.xml
 */
function matchesPostTypeFilter(sitemapUrl, postTypeFilter) {
  if (!postTypeFilter || postTypeFilter === 'all') {
    return true;
  }

  const lowerUrl = sitemapUrl.toLowerCase();

  // WordPress Yoast/RankMath sitemap naming conventions
  if (postTypeFilter === 'pages') {
    // Include page sitemaps, exclude post sitemaps
    return lowerUrl.includes('page-sitemap') ||
           lowerUrl.includes('page_sitemap') ||
           (!lowerUrl.includes('post-sitemap') &&
            !lowerUrl.includes('post_sitemap') &&
            !lowerUrl.includes('category') &&
            !lowerUrl.includes('tag') &&
            !lowerUrl.includes('author'));
  }

  if (postTypeFilter === 'posts') {
    // Include post sitemaps only
    return lowerUrl.includes('post-sitemap') ||
           lowerUrl.includes('post_sitemap');
  }

  return true;
}

/**
 * Parse a sitemap and extract all URLs
 * Handles both regular sitemaps and sitemap index files
 * @param {string} sitemapUrl - URL to the sitemap
 * @param {string} postTypeFilter - 'all', 'pages', or 'posts'
 */
async function parse(sitemapUrl, postTypeFilter = 'all', crawlContext = null) {
  const urls = [];
  const context = crawlContext || { visited: new Set(), depth: 0, maxDepth: 6, maxUrls: 5000, origin: new URL(sitemapUrl).origin };
  if (new URL(sitemapUrl).origin !== context.origin) throw new Error('Nested sitemap must stay on the same site.');
  if (context.visited.size >= 100) throw new Error('Sitemap file limit reached. Supply a smaller sitemap.');

  if (context.depth > context.maxDepth) {
    throw new Error(`Sitemap nesting exceeds the maximum depth of ${context.maxDepth}`);
  }
  if (context.visited.has(sitemapUrl)) return urls;
  context.visited.add(sitemapUrl);

  try {
    let response;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        response = await axios.get(sitemapUrl, {
          timeout: 45000,
          maxRedirects: 0,
          maxContentLength: 10 * 1024 * 1024,
          headers: getSitemapHeaders(sitemapUrl),
          decompress: true
        });
        break;
      } catch (fetchError) {
        if (attempt === 2) throw fetchError;
        // Brief pause before retry
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    const contentType = response.headers['content-type'] || '';
    const body = typeof response.data === 'string' ? response.data : String(response.data);

    // Detect HTML sitemap (not XML)
    if (contentType.includes('text/html') || (!contentType.includes('xml') && (body.trimStart().startsWith('<!') || body.trimStart().startsWith('<html')))) {
      const htmlUrls = parseHtmlSitemap(body, sitemapUrl);
      urls.push(...htmlUrls);
      return urls;
    }

    const data = parser.parse(body);

    // Check if this is a sitemap index
    if (data.sitemapindex && data.sitemapindex.sitemap) {
      const sitemaps = Array.isArray(data.sitemapindex.sitemap)
        ? data.sitemapindex.sitemap
        : [data.sitemapindex.sitemap];

      // Recursively parse each nested sitemap (filtered by post type)
      for (const sitemap of sitemaps) {
        const nestedUrl = sitemap.loc;
        if (nestedUrl && matchesPostTypeFilter(nestedUrl, postTypeFilter)) {
          const nestedUrls = await parse(nestedUrl, postTypeFilter, { ...context, depth: context.depth + 1 });
          urls.push(...nestedUrls);
          if (urls.length >= context.maxUrls) return urls.slice(0, context.maxUrls);
        }
      }
    }
    // Regular sitemap with urlset
    else if (data.urlset && data.urlset.url) {
      const urlEntries = Array.isArray(data.urlset.url)
        ? data.urlset.url
        : [data.urlset.url];

      for (const entry of urlEntries) {
        if (entry.loc) {
          urls.push(entry.loc);
          if (urls.length >= context.maxUrls) break;
        }
      }
    }
  } catch (error) {
    throw new Error(`Failed to parse sitemap: ${error.message}`);
  }

  return urls;
}

/**
 * Parse an HTML sitemap page and extract internal links
 * @param {string} html - HTML content
 * @param {string} sitemapUrl - The sitemap URL (used to resolve relative links)
 * @returns {string[]} - Array of URLs
 */
function parseHtmlSitemap(html, sitemapUrl) {
  const $ = cheerio.load(html);
  const origin = new URL(sitemapUrl).origin;
  const urls = new Set();

  $('a[href]').each((_, el) => {
    let href = $(el).attr('href');
    if (!href) return;

    // Resolve relative URLs
    if (href.startsWith('/')) {
      href = origin + href;
    }

    // Only include same-origin http(s) URLs, skip anchors/mailto/tel
    if (!href.startsWith(origin)) return;
    if (href.includes('#') || href.includes('mailto:') || href.includes('tel:')) return;

    // Skip common non-content paths
    const path = new URL(href).pathname.toLowerCase();
    if (path.match(/\.(jpg|jpeg|png|gif|svg|webp|pdf|css|js|xml|zip)$/)) return;
    if (path.startsWith('/wp-admin') || path.startsWith('/wp-login') || path.startsWith('/wp-content')) return;
    if (path.startsWith('/cart') || path.startsWith('/checkout') || path.startsWith('/my-account')) return;
    if (path === '/html-sitemap/' || path === '/html-sitemap') return;

    urls.add(href.replace(/\/$/, '') + '/'); // Normalize trailing slash
  });

  return [...urls];
}

/**
 * Try common sitemap locations
 */
async function findSitemap(siteUrl) {
  const baseUrl = siteUrl.replace(/\/$/, '');
  const commonPaths = [
    '/sitemap.xml',
    '/sitemap_index.xml',
    '/wp-sitemap.xml',
    '/sitemap/sitemap-index.xml',
    '/html-sitemap/'
  ];

  for (const path of commonPaths) {
    try {
      const url = baseUrl + path;
      await axios.head(url, {
        timeout: 5000,
        headers: getSitemapHeaders(url)
      });
      return url;
    } catch {
      // Try next path
    }
  }

  throw new Error('No sitemap found');
}

module.exports = {
  parse,
  findSitemap
};
