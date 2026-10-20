const cheerio = require('cheerio');
const { XMLParser } = require('fast-xml-parser');
const { fetchWithRetry } = require('./pageScraper');

const parser = new XMLParser({
  processEntities: false,
  ignoreAttributes: false,
  attributeNamePrefix: '@_'
});

/**
 * Same site, treating www and the bare domain as one (sites often list one and redirect to the other).
 */
function sameSite(a, b) {
  const host = value => new URL(value).host.toLowerCase().replace(/^www\./, '');
  try { return host(a) === host(b); } catch { return false; }
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
  const context = crawlContext || { visited: new Set(), depth: 0, maxDepth: 6, maxUrls: 5000, origin: new URL(sitemapUrl).origin, warnings: [] };
  if (!sameSite(sitemapUrl, context.origin)) throw new Error('Nested sitemap must stay on the same site.');
  if (context.visited.size >= 100) throw new Error('Sitemap file limit reached. Supply a smaller sitemap.');

  if (context.depth > context.maxDepth) {
    throw new Error(`Sitemap nesting exceeds the maximum depth of ${context.maxDepth}`);
  }
  if (context.visited.has(sitemapUrl)) return urls;
  context.visited.add(sitemapUrl);

  try {
    const response = await fetchWithRetry(sitemapUrl, { maxRetries: 2 });
    const finalUrl = response.request?.res?.responseUrl || sitemapUrl;
    if (!sameSite(finalUrl, context.origin)) throw new Error(`Sitemap redirected off-site to ${finalUrl}`);
    const contentType = response.headers['content-type'] || '';
    const body = typeof response.data === 'string' ? response.data : String(response.data);

    // Detect HTML sitemap (not XML)
    if (contentType.includes('text/html') || (!contentType.includes('xml') && (body.trimStart().startsWith('<!') || body.trimStart().startsWith('<html')))) {
      const htmlUrls = parseHtmlSitemap(body, finalUrl);
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
          // One broken child sitemap shouldn't sink the whole crawl; note it and keep going.
          try {
            urls.push(...await parse(nestedUrl, postTypeFilter, { ...context, depth: context.depth + 1 }));
          } catch (nestedError) {
            (context.warnings ||= []).push(nestedError.message);
          }
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
 * Find the site's sitemap: robots.txt "Sitemap:" lines first, then common locations.
 * Uses GET, since many hosts and CDNs reject or mishandle HEAD.
 */
async function findSitemap(siteUrl) {
  const baseUrl = siteUrl.replace(/\/$/, '');
  const candidates = [];
  try {
    const robots = await fetchWithRetry(`${baseUrl}/robots.txt`, { maxRetries: 1, timeout: 15000 });
    for (const match of String(robots.data).matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
      if (sameSite(match[1], baseUrl)) candidates.push(match[1]);
    }
  } catch { /* No robots.txt; fall through to common paths. */ }
  candidates.push(...['/sitemap_index.xml', '/sitemap.xml', '/wp-sitemap.xml', '/sitemap/sitemap-index.xml', '/page-sitemap.xml', '/html-sitemap/'].map(path => baseUrl + path));

  for (const url of [...new Set(candidates)]) {
    try {
      const response = await fetchWithRetry(url, { maxRetries: 1, timeout: 15000 });
      const body = String(response.data).trimStart();
      if (/<(urlset|sitemapindex)[\s>]/.test(body) || (url.endsWith('/') && /<a\s/i.test(body))) return response.request?.res?.responseUrl || url;
    } catch {
      // Try next location
    }
  }

  throw new Error('No sitemap found');
}

module.exports = {
  parse,
  findSitemap,
  sameSite
};
