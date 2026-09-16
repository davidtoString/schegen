const axios = require('axios');
const http = require('http');
const https = require('https');
const cheerio = require('cheerio');

// Disable keep-alive to prevent "socket hang up" from stale connections
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

/**
 * User-Agent rotation pool - real browser user agents
 */
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0'
];

/**
 * Get a random User-Agent from the pool
 */
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Delay helper for rate limiting
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Last request timestamp for rate limiting
 */
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1500; // Minimum 1.5 seconds between requests

/**
 * Get browser-like headers for a given URL
 */
function getBrowserHeaders(url) {
  const urlObj = new URL(url);
  const userAgent = getRandomUserAgent();

  return {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
    'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    // Add referer for subsequent requests (looks more natural)
    'Referer': `${urlObj.protocol}//${urlObj.host}/`
  };
}

/**
 * Fetch a page with retry logic for transient errors (socket hang up, timeouts)
 */
async function fetchWithRetry(url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: 45000,
        maxRedirects: 5,
        maxContentLength: 5 * 1024 * 1024,
        validateStatus: (status) => status < 400,
        headers: getBrowserHeaders(url),
        withCredentials: false,
        decompress: true,
        httpAgent,
        httpsAgent
      });
      return response;
    } catch (error) {
      // Don't retry on permanent errors (4xx, DNS failure, etc.)
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') throw error;
      if (error.response && error.response.status < 500) throw error;

      if (attempt < maxRetries) {
        // Exponential backoff: 2s, 4s
        await delay(2000 * attempt);
        continue;
      }
      throw error;
    }
  }
}

/**
 * Fetch raw HTML for a URL, with rate limiting.
 * @param {string} url - URL to fetch
 * @returns {string} - Raw HTML string
 */
async function fetchHtml(url) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await delay(MIN_REQUEST_INTERVAL - timeSinceLastRequest);
  }
  lastRequestTime = Date.now();

  const response = await fetchWithRetry(url);
  return response.data;
}

/**
 * Scrape a page and extract relevant content for schema generation
 */
async function scrape(url) {
  try {
    const html = await fetchHtml(url);

    const $ = cheerio.load(html);

    // Extract main content; fall back to visible body text if selectors miss
    let content = extractContent($);
    let textContent = '';
    if (!content) {
      // Remove non-visible elements then grab body text as fallback
      const $clone = $.root().clone();
      $clone.find('script, style, noscript, svg, iframe, nav').remove();
      textContent = $clone.find('body').text().replace(/\s+/g, ' ').trim().substring(0, 5000);
    }

    const pageData = {
      url,
      language: $('html').attr('lang') || '',
      robots: $('meta[name="robots"]').attr('content') || '',
      title: extractTitle($),
      description: extractDescription($),
      content,
      textContent,
      headings: extractHeadings($),
      author: extractAuthor($),
      publishDate: extractPublishDate($),
      modifiedDate: extractModifiedDate($),
      featuredImage: extractFeaturedImage($),
      categories: extractCategories($),
      tags: extractTags($),
      existingSchema: extractExistingSchema($),
      wordpressInfo: extractWordPressInfo($),
      faqs: extractFAQs($),
      breadcrumbs: extractBreadcrumbs($, url),
      phone: extractPhone($),
      serviceAreas: extractServiceAreas($)
    };

    console.log(`[scrape] ${url}: title="${(pageData.title||'').substring(0,50)}" content=${content.length} textContent=${textContent.length} faqs=${pageData.faqs.length}`);

    return pageData;
  } catch (error) {
    // Provide more descriptive error messages
    if (error.code === 'ECONNREFUSED') {
      throw new Error(`Failed to connect to ${url} - connection refused`);
    }
    if (error.code === 'ENOTFOUND') {
      throw new Error(`Failed to resolve hostname for ${url} - check the URL`);
    }
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      throw new Error(`Request to ${url} timed out after retries`);
    }
    if (error.response) {
      throw new Error(`Failed to fetch ${url} - HTTP ${error.response.status}: ${error.response.statusText}`);
    }
    throw new Error(`Failed to scrape ${url}: ${error.message}`);
  }
}

function extractTitle($) {
  // Try various title sources
  return (
    $('meta[property="og:title"]').attr('content') ||
    $('h1.entry-title').text().trim() ||
    $('h1').first().text().trim() ||
    $('title').text().trim()
  );
}

function extractDescription($) {
  return (
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    $('p').first().text().trim().substring(0, 160)
  );
}

function extractContent($) {
  // Try common content containers
  const contentSelectors = [
    '.entry-content',
    '.post-content',
    'article .content',
    '.page-content',
    'main article',
    'article',
    'main'
  ];

  for (const selector of contentSelectors) {
    const container = $(selector).clone();
    container.find('script, style, noscript, nav').remove();
    const content = container.text().replace(/\s+/g, ' ').trim();
    if (content) {
      return content.substring(0, 5000); // Limit content length
    }
  }

  return '';
}

function extractHeadings($) {
  const headings = [];
  $('h1, h2, h3').each((_, el) => {
    const text = $(el).text().trim();
    if (text) {
      headings.push({
        level: el.tagName.toLowerCase(),
        text
      });
    }
  });
  return headings;
}

function extractAuthor($) {
  return (
    $('meta[name="author"]').attr('content') ||
    $('meta[property="article:author"]').attr('content') ||
    $('.author-name').text().trim() ||
    $('[rel="author"]').text().trim() ||
    $('.byline a').text().trim() ||
    ''
  );
}

function extractPublishDate($) {
  const dateStr = (
    $('meta[property="article:published_time"]').attr('content') ||
    $('time[datetime]').attr('datetime') ||
    $('.entry-date').attr('datetime') ||
    $('[itemprop="datePublished"]').attr('content') ||
    ''
  );

  if (dateStr) {
    try {
      return new Date(dateStr).toISOString();
    } catch {
      return dateStr;
    }
  }
  return '';
}

function extractModifiedDate($) {
  const dateStr = (
    $('meta[property="article:modified_time"]').attr('content') ||
    $('[itemprop="dateModified"]').attr('content') ||
    ''
  );

  if (dateStr) {
    try {
      return new Date(dateStr).toISOString();
    } catch {
      return dateStr;
    }
  }
  return '';
}

// Filenames/classes/alt text typical of dividers, spacers, icons, logos and other
// decorative images that are not a page's actual content photo.
const DECORATIVE_IMAGE_PATTERN = /divider|separator|spacer|border|pixel|blank|transparent|bullet|icon|logo|badge|avatar|arrow|chevron|social|share|rating|star|placeholder/i;
const MIN_CONTENT_IMAGE_DIMENSION = 100;

function isLikelyContentImage($, el) {
  const src = $(el).attr('src') || '';
  if (!src || /\.svg(\?|$)/i.test(src)) return false;
  const width = parseInt($(el).attr('width'), 10);
  const height = parseInt($(el).attr('height'), 10);
  if ((Number.isFinite(width) && width < MIN_CONTENT_IMAGE_DIMENSION) || (Number.isFinite(height) && height < MIN_CONTENT_IMAGE_DIMENSION)) return false;
  const signals = [src, $(el).attr('class') || '', $(el).attr('id') || '', $(el).attr('alt') || ''].join(' ');
  return !DECORATIVE_IMAGE_PATTERN.test(signals);
}

function extractFeaturedImage($) {
  // og:image / itemprop=image are explicit metadata the site declares for sharing — trust them as-is.
  const declared = $('meta[property="og:image"]').attr('content') || $('meta[property="og:image:url"]').attr('content') || $('[itemprop="image"]').attr('content');
  if (declared) return declared;
  // Otherwise, scan for the first plausible content photo, skipping dividers/spacers/icons/logos.
  const candidate = $('article img').toArray().find(el => isLikelyContentImage($, el));
  return candidate ? $(candidate).attr('src') : '';
}

function extractCategories($) {
  const categories = [];
  $('[rel="category tag"], .category-link, .post-categories a').each((_, el) => {
    const text = $(el).text().trim();
    if (text) categories.push(text);
  });
  return categories;
}

function extractTags($) {
  const tags = [];
  $('[rel="tag"], .tag-link, .post-tags a').each((_, el) => {
    const text = $(el).text().trim();
    if (text) tags.push(text);
  });
  return tags;
}

function extractExistingSchema($) {
  const schemas = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const schema = JSON.parse($(el).html());
      schemas.push(schema);
    } catch {
      // Invalid JSON, skip
    }
  });
  return schemas;
}

function extractWordPressInfo($) {
  // Look for WordPress-specific indicators
  const bodyClass = $('body').attr('class') || '';
  const isPost = bodyClass.includes('single-post') || bodyClass.includes('postid-');
  const isPage = bodyClass.includes('page-template') || bodyClass.includes('page-id-');

  // Extract post ID if available
  const postIdMatch = bodyClass.match(/(?:postid-|page-id-)(\d+)/);
  const postId = postIdMatch ? postIdMatch[1] : null;

  return {
    isWordPress: bodyClass.includes('wp-') || bodyClass.includes('wordpress'),
    postType: isPost ? 'post' : isPage ? 'page' : 'unknown',
    postId
  };
}

/**
 * Extract FAQs from the page
 * Looks for common FAQ patterns: accordions, FAQ sections, Q&A lists
 */
function extractFAQs($) {
  const faqs = [];

  // Pattern 1: FAQ sections with headers and content
  // Common selectors for FAQ items
  const faqSelectors = [
    '.faq-item',
    '.faq',
    '.accordion-item',
    '.elementor-accordion-item',
    '.wp-block-yoast-faq-block',
    '[itemtype*="Question"]',
    '.schema-faq-question',
    '.question-answer',
    '.qa-item'
  ];

  for (const selector of faqSelectors) {
    $(selector).each((_, el) => {
      const $el = $(el);
      const question = $el.find('.faq-question, .accordion-title, .elementor-tab-title, [itemprop="name"], .question, h3, h4, button').first().text().trim();
      const answer = $el.find('.faq-answer, .accordion-content, .elementor-tab-content, [itemprop="text"], .answer, .content, p').first().text().trim();

      if (question && answer && question.length > 10 && answer.length > 20) {
        faqs.push({ question, answer });
      }
    });
  }

  // Pattern 1b: Elementor Nested Accordion (details/summary structure)
  if (faqs.length === 0) {
    $('details.e-n-accordion-item').each((_, el) => {
      const $el = $(el);
      const question = $el.find('.e-n-accordion-item-title-text').first().text().trim();
      // Answer can be in p tags OR directly in .e-con container (no p tags)
      let answer = $el.find('.elementor-widget-text-editor p, .e-con p').first().text().trim();
      // If no p tags found, get text directly from .e-con (excluding the summary/title)
      if (!answer) {
        const $content = $el.find('.e-con').first();
        if ($content.length) {
          // Clone and remove the title element to get just the answer text
          const $clone = $content.clone();
          $clone.find('.e-n-accordion-item-title').remove();
          answer = $clone.text().trim();
        }
      }

      if (question && answer && question.length > 10 && answer.length > 20) {
        faqs.push({ question, answer });
      }
    });
  }

  // Pattern 2: Look for FAQ heading followed by Q&A structure
  if (faqs.length === 0) {
    $('h2, h3').each((_, heading) => {
      const headingText = $(heading).text().toLowerCase();
      if (headingText.includes('faq') || headingText.includes('frequently asked') || headingText.includes('questions')) {
        // Get following siblings that might be Q&A
        let $next = $(heading).next();
        while ($next.length && !$next.is('h2')) {
          if ($next.is('h3, h4, strong, b, dt')) {
            const question = $next.text().trim();
            const $answerEl = $next.next('p, dd, div');
            const answer = $answerEl.text().trim();
            if (question && answer && question.length > 10) {
              faqs.push({ question, answer });
            }
          }
          $next = $next.next();
        }
      }
    });
  }

  // Pattern 3: Definition lists (dl/dt/dd)
  if (faqs.length === 0) {
    $('dl').each((_, dl) => {
      $(dl).find('dt').each((_, dt) => {
        const question = $(dt).text().trim();
        const answer = $(dt).next('dd').text().trim();
        if (question && answer) {
          faqs.push({ question, answer });
        }
      });
    });
  }

  // Pattern 4: Look for text patterns like "Q:" or "Question:"
  if (faqs.length === 0) {
    const content = extractContent($);
    const qaPairs = content.match(/(?:Q:|Question:)\s*([^\n?]+\?)\s*(?:A:|Answer:)\s*([^\n]+)/gi);
    if (qaPairs) {
      qaPairs.forEach(pair => {
        const match = pair.match(/(?:Q:|Question:)\s*([^\n?]+\?)\s*(?:A:|Answer:)\s*([^\n]+)/i);
        if (match) {
          faqs.push({ question: match[1].trim(), answer: match[2].trim() });
        }
      });
    }
  }

  // Deduplicate and limit
  const seen = new Set();
  return faqs.filter(faq => {
    const key = faq.question.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

/**
 * Extract breadcrumbs from the page
 */
function extractBreadcrumbs($, url) {
  const breadcrumbs = [];

  // Look for common breadcrumb selectors
  const breadcrumbSelectors = [
    '.breadcrumb',
    '.breadcrumbs',
    '[itemtype*="BreadcrumbList"]',
    '.yoast-breadcrumb',
    '.rank-math-breadcrumb',
    '#breadcrumbs',
    'nav.breadcrumb',
    '.woocommerce-breadcrumb'
  ];

  for (const selector of breadcrumbSelectors) {
    const $container = $(selector).first();
    if ($container.length) {
      $container.find('a').each((_, el) => {
        const name = $(el).text().trim();
        const href = $(el).attr('href');
        if (name && href) {
          breadcrumbs.push({ name, url: href });
        }
      });

      // Add current page (last item, usually not a link)
      const lastText = $container.find('span:last-child, li:last-child').text().trim();
      if (lastText && lastText !== breadcrumbs[breadcrumbs.length - 1]?.name) {
        breadcrumbs.push({ name: lastText, url: url });
      }

      if (breadcrumbs.length > 0) {
        return breadcrumbs;
      }
    }
  }

  return breadcrumbs;
}

/**
 * Extract phone number from the page
 */
function extractPhone($) {
  // Look for phone in common locations
  const phonePatterns = [
    /(?:tel:|phone:|call[:\s]+)?\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/i,
    /1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/
  ];

  // Check meta tags first
  const metaPhone = $('meta[name="phone"]').attr('content') ||
                    $('meta[property="business:contact_data:phone_number"]').attr('content');
  if (metaPhone) return metaPhone;

  // Check common phone containers
  const phoneSelectors = [
    'a[href^="tel:"]',
    '.phone',
    '.phone-number',
    '.contact-phone',
    '[itemprop="telephone"]'
  ];

  for (const selector of phoneSelectors) {
    const phone = $(selector).first().text().trim() || $(selector).first().attr('href')?.replace('tel:', '');
    if (phone) {
      const cleaned = phone.replace(/[^\d]/g, '');
      if (cleaned.length >= 10) {
        return phone;
      }
    }
  }

  // Search in header/footer
  const headerFooter = $('header, footer, .header, .footer').text();
  for (const pattern of phonePatterns) {
    const match = headerFooter.match(pattern);
    if (match) {
      return match[0].trim();
    }
  }

  return '';
}

/**
 * Extract service areas from the page
 */
function extractServiceAreas($) {
  const areas = [];

  // Look for service area sections with various selectors
  const areaSelectors = [
    '.service-areas',
    '.areas-served',
    '.locations',
    '.service-area',
    '#service-areas',
    '#areas-served',
    '#locations',
    '[class*="service-area"]',
    '[class*="areas-served"]',
    '[class*="location-list"]',
    '.footer-locations',
    '.city-list',
    '.towns-served'
  ];

  for (const selector of areaSelectors) {
    $(selector).find('li, a, span, p').each((_, el) => {
      const text = $(el).text().trim();
      // Filter out navigation items and keep city-like names
      if (text && text.length > 2 && text.length < 50 &&
          !text.includes('http') && !text.includes('@') &&
          !text.match(/^\d+$/) && !text.match(/^[\d\-\(\)]+$/)) {
        areas.push(text);
      }
    });
    if (areas.length > 0) break;
  }

  // Look for links to location pages in navigation/footer
  if (areas.length === 0) {
    $('a[href*="/location"], a[href*="/areas"], a[href*="/service-area"], a[href*="/cities"]').each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 2 && text.length < 40 && !text.toLowerCase().includes('view all')) {
        areas.push(text);
      }
    });
  }

  // Look for "Serving" or "Service Areas" text patterns in footer
  if (areas.length === 0) {
    const footerText = $('footer').text() || '';
    const servingPatterns = [
      /(?:serving|proudly serving|we serve|service areas?|locations?)[:\s]+([^.!?\n]+)/i,
      /(?:serving|service)\s+(?:the\s+)?(?:greater\s+)?([A-Z][a-z]+(?:[\s,]+(?:and\s+)?[A-Z][a-z]+)*)\s+(?:area|region|community|and surrounding)/i
    ];

    for (const pattern of servingPatterns) {
      const match = footerText.match(pattern);
      if (match && match[1]) {
        const areaList = match[1].split(/,|\band\b|&/).map(a => a.trim()).filter(a => a.length > 2 && a.length < 50);
        areas.push(...areaList);
        if (areas.length > 0) break;
      }
    }
  }

  // Try body text as last resort
  if (areas.length === 0) {
    const content = $('body').text();
    const servingMatch = content.match(/(?:serving|service areas?|we serve)[:\s]+([^.!?\n]+)/i);
    if (servingMatch) {
      const areaList = servingMatch[1].split(/,|\band\b|&/).map(a => a.trim()).filter(a => a.length > 2 && a.length < 50);
      areas.push(...areaList);
    }
  }

  // Clean up and deduplicate
  const cleaned = areas
    .map(a => a.replace(/^[\s\-•·]+/, '').trim())  // Remove leading bullets/dashes
    .filter(a => a.length > 2 && a.length < 50)
    .filter(a => !a.match(/^(home|about|contact|services|blog|faq|privacy|terms)/i));  // Filter nav items

  return [...new Set(cleaned)].slice(0, 30);  // Allow more areas
}


module.exports = {
  scrape
};
