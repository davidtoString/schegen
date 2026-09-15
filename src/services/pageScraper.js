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
 * Fetch raw HTML for a URL.
 * Tries the RankMath helper plugin first (server-side, bypasses CDN/WAF),
 * then falls back to direct fetch with rate limiting.
 * @param {string} url - URL to fetch
 * @param {object} [helperConfig] - { siteUrl, secretToken } for helper plugin
 * @returns {string} - Raw HTML string
 */
async function fetchHtml(url, helperConfig) {
  // Try via RankMath helper plugin (server-to-server, bypasses CDN/WAF)
  if (helperConfig && helperConfig.siteUrl && helperConfig.secretToken) {
    try {
      const rankMathClient = require('./rankMathClient');
      const client = rankMathClient.create(helperConfig);
      const result = await client.getPageHtml(url);
      if (result.success && result.html && result.status_code >= 200 && result.status_code < 400) {
        console.log(`[fetchHtml] Helper returned ${result.html.length} chars for ${url} (status ${result.status_code})`);
        return result.html;
      }
      console.log(`[fetchHtml] Helper returned empty/failed for ${url}, falling back`);
    } catch (e) {
      // Helper failed, fall through to direct fetch
      console.log(`[fetchHtml] Helper fetch failed for ${url}, falling back to direct: ${e.message}`);
    }
  }

  // Direct fetch with rate limiting
  console.log(`[fetchHtml] Using direct fetch for ${url} (no helper or helper failed)`);
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await delay(MIN_REQUEST_INTERVAL - timeSinceLastRequest);
  }
  lastRequestTime = Date.now();

  const response = await fetchWithRetry(url);
  console.log(`[fetchHtml] Direct fetch returned ${(response.data || '').length} chars for ${url} (status ${response.status})`);
  return response.data;
}

/**
 * Scrape a page and extract relevant content for schema generation
 */
async function scrape(url, options = {}) {
  try {
    const html = await fetchHtml(url, options.helperConfig);

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

function extractFeaturedImage($) {
  return (
    $('meta[property="og:image"]').attr('content') ||
    $('meta[property="og:image:url"]').attr('content') ||
    $('[itemprop="image"]').attr('content') ||
    $('article img').first().attr('src') ||
    ''
  );
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

/**
 * Extract organization info from a page (usually homepage)
 * @param {string} url - URL to scrape (typically homepage)
 * @returns {object} - Organization info
 */
async function scrapeOrgInfo(url, helperConfig) {
  try {
    const html = await fetchHtml(url, helperConfig);

    const $ = cheerio.load(html);

    // Extract base URL
    const urlObj = new URL(url);
    const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

    // Extract organization name
    const orgName = extractOrgName($, baseUrl);

    // Extract logo
    const logo = extractLogo($, baseUrl);

    // Extract phone
    const phone = extractPhone($);

    // Extract address
    const address = extractAddress($);

    // Extract social profiles
    const socialProfiles = extractSocialProfiles($);

    // Extract service areas from page
    const serviceAreas = extractServiceAreas($);

    // Extract email
    const email = extractEmail($);

    // Detect business type from content
    const businessType = detectBusinessType($);

    return {
      name: orgName,
      url: baseUrl,
      logo: logo,
      phone: phone,
      email: email,
      address: address,
      serviceAreas: serviceAreas,
      socialProfiles: socialProfiles,
      businessType: businessType
    };
  } catch (error) {
    throw new Error(`Failed to scrape organization info: ${error.message}`);
  }
}

/**
 * Extract organization name
 */
function extractOrgName($, baseUrl) {
  // Try various sources for org name
  return (
    $('meta[property="og:site_name"]').attr('content') ||
    $('[itemtype*="Organization"] [itemprop="name"]').first().text().trim() ||
    $('[itemtype*="LocalBusiness"] [itemprop="name"]').first().text().trim() ||
    $('.site-title, .logo-text, .brand-name').first().text().trim() ||
    $('header .logo a').first().text().trim() ||
    $('header a[href="/"], header a[href="' + baseUrl + '"]').first().text().trim() ||
    $('footer .company-name, footer .business-name').first().text().trim() ||
    $('title').text().split('|')[0].split('-')[0].trim() ||
    ''
  );
}

/**
 * Extract logo URL
 */
function extractLogo($, baseUrl) {
  let logo = (
    $('meta[property="og:image"]').attr('content') ||
    $('[itemtype*="Organization"] [itemprop="logo"]').attr('src') ||
    $('[itemtype*="Organization"] [itemprop="logo"] img').attr('src') ||
    $('header .logo img, .site-logo img, .custom-logo').first().attr('src') ||
    $('header img[alt*="logo" i]').first().attr('src') ||
    $('img.logo, img[class*="logo"]').first().attr('src') ||
    ''
  );

  // Make absolute URL if relative
  if (logo && !logo.startsWith('http')) {
    logo = new URL(logo, baseUrl).href;
  }

  return logo;
}

/**
 * Extract address from page
 */
function extractAddress($) {
  // Look for structured address (Schema.org microdata)
  const streetAddress = $('[itemprop="streetAddress"]').first().text().trim();
  const city = $('[itemprop="addressLocality"]').first().text().trim();
  const state = $('[itemprop="addressRegion"]').first().text().trim();
  const postalCode = $('[itemprop="postalCode"]').first().text().trim();
  const country = $('[itemprop="addressCountry"]').first().text().trim();

  if (streetAddress || city) {
    const detectedCountry = detectCountryFromData(postalCode, state, city);
    return {
      streetAddress: streetAddress || undefined,
      addressLocality: city || undefined,
      addressRegion: state || undefined,
      postalCode: postalCode || undefined,
      addressCountry: country || detectedCountry
    };
  }

  // Extended list of address selectors
  const addressSelectors = [
    '.address',
    '.contact-address',
    '.footer-address',
    '.business-address',
    '.company-address',
    '.location-address',
    '[class*="address"]',
    '[class*="location"]',
    'address',
    '.contact-info',
    '.footer .contact',
    'footer address',
    '.widget_text address',
    '.elementor-widget-text-editor address'
  ];

  for (const selector of addressSelectors) {
    const $el = $(selector).first();
    const text = $el.text().trim();
    if (text && text.length > 10 && text.length < 300) {
      const parsed = parseAddressText(text);
      if (parsed) return parsed;
    }
  }

  // Look for address in footer text using patterns
  const footerText = $('footer').text();
  const parsed = parseAddressText(footerText);
  if (parsed) return parsed;

  // Try to find address near phone numbers (often together in contact sections)
  const contactSections = $('*:contains("Contact"), *:contains("Address"), *:contains("Location")').filter((_, el) => {
    const text = $(el).text();
    return text.length < 500 && text.length > 20;
  });

  for (let i = 0; i < Math.min(contactSections.length, 5); i++) {
    const text = $(contactSections[i]).text().trim();
    const parsed = parseAddressText(text);
    if (parsed && parsed.streetAddress) return parsed;
  }

  return null;
}

/**
 * Parse address from text using various patterns
 */
function parseAddressText(text) {
  if (!text) return null;

  // Canadian postal code pattern: A1A 1A1
  const canadianPostalMatch = text.match(/([A-Z]\d[A-Z])\s*(\d[A-Z]\d)/i);

  // US ZIP code pattern: 12345 or 12345-6789
  const usZipMatch = text.match(/\b(\d{5})(?:-\d{4})?\b/);

  // Street address patterns
  const streetPatterns = [
    /(\d+[\s\-]?\w*\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir|Highway|Hwy|Parkway|Pkwy)[.,]?)/i,
    /(\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir|Highway|Hwy|Parkway|Pkwy))/i
  ];

  let streetAddress = '';
  for (const pattern of streetPatterns) {
    const match = text.match(pattern);
    if (match) {
      streetAddress = match[1].trim().replace(/[,.]$/, '');
      break;
    }
  }

  // Canadian provinces
  const canadianProvinces = {
    'ON': 'Ontario', 'QC': 'Quebec', 'BC': 'British Columbia', 'AB': 'Alberta',
    'MB': 'Manitoba', 'SK': 'Saskatchewan', 'NS': 'Nova Scotia', 'NB': 'New Brunswick',
    'NL': 'Newfoundland', 'PE': 'Prince Edward Island', 'NT': 'Northwest Territories',
    'YT': 'Yukon', 'NU': 'Nunavut'
  };

  // US states (abbreviated)
  const usStates = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC',
    'ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

  // Ontario cities (common for HVAC businesses)
  const ontarioCities = ['Hamilton', 'Toronto', 'Ottawa', 'Mississauga', 'Brampton', 'Burlington',
    'Oakville', 'Stoney Creek', 'Ancaster', 'Dundas', 'Waterdown', 'Grimsby', 'St. Catharines',
    'St Catharines', 'Niagara', 'London', 'Kitchener', 'Waterloo', 'Cambridge', 'Guelph',
    'Binbrook', 'Caledonia', 'Brantford', 'Milton', 'Georgetown'];

  let addressLocality = '';
  let addressRegion = '';
  let postalCode = '';
  let addressCountry = '';

  // Extract postal/zip code
  if (canadianPostalMatch) {
    postalCode = `${canadianPostalMatch[1].toUpperCase()} ${canadianPostalMatch[2].toUpperCase()}`;
    addressCountry = 'CA';
  } else if (usZipMatch) {
    postalCode = usZipMatch[0];
    addressCountry = 'US';
  }

  // Look for province/state
  for (const [abbr, full] of Object.entries(canadianProvinces)) {
    const pattern = new RegExp(`\\b(${abbr}|${full})\\b`, 'i');
    if (pattern.test(text)) {
      addressRegion = abbr;
      addressCountry = 'CA';
      break;
    }
  }

  if (!addressRegion) {
    for (const state of usStates) {
      const pattern = new RegExp(`\\b${state}\\b`);
      if (pattern.test(text)) {
        addressRegion = state;
        if (!addressCountry) addressCountry = 'US';
        break;
      }
    }
  }

  // Look for city
  for (const city of ontarioCities) {
    const pattern = new RegExp(`\\b${city.replace('.', '\\.')}\\b`, 'i');
    if (pattern.test(text)) {
      addressLocality = city;
      if (!addressRegion) addressRegion = 'ON';
      if (!addressCountry) addressCountry = 'CA';
      break;
    }
  }

  // Try to extract city from comma-separated parts if not found
  if (!addressLocality && (streetAddress || postalCode)) {
    const parts = text.split(/[,\n]+/).map(p => p.trim()).filter(p => p && p.length > 2 && p.length < 50);
    for (const part of parts) {
      // Skip if it looks like a street, postal code, or phone
      if (part.match(/^\d+\s/) || part.match(/^[A-Z]\d[A-Z]/i) || part.match(/^\d{5}/) || part.match(/\d{3}.*\d{4}/)) {
        continue;
      }
      // Likely a city name
      if (part.match(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?$/)) {
        addressLocality = part;
        break;
      }
    }
  }

  // Only return if we found something useful
  if (streetAddress || addressLocality || postalCode) {
    return {
      streetAddress: streetAddress || undefined,
      addressLocality: addressLocality || undefined,
      addressRegion: addressRegion || undefined,
      postalCode: postalCode || undefined,
      addressCountry: addressCountry || 'CA'
    };
  }

  return null;
}

/**
 * Detect country from postal code, state, or city
 */
function detectCountryFromData(postalCode, state, city) {
  // Canadian postal code format: A1A 1A1 or A1A1A1
  if (postalCode && /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i.test(postalCode)) {
    return 'CA';
  }

  // US ZIP code format: 12345 or 12345-6789
  if (postalCode && /^\d{5}(-\d{4})?$/.test(postalCode)) {
    return 'US';
  }

  // Canadian provinces
  const canadianProvinces = ['ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE', 'NT', 'YT', 'NU',
    'Ontario', 'Quebec', 'British Columbia', 'Alberta', 'Manitoba', 'Saskatchewan'];
  if (state && canadianProvinces.some(p => p.toLowerCase() === state.toLowerCase())) {
    return 'CA';
  }

  // Ontario cities
  const ontarioCities = ['Hamilton', 'Toronto', 'Ottawa', 'Mississauga', 'Burlington', 'Oakville',
    'Stoney Creek', 'Ancaster', 'Dundas', 'St. Catharines', 'St Catharines'];
  if (city && ontarioCities.some(c => c.toLowerCase() === city.toLowerCase())) {
    return 'CA';
  }

  return 'US';
}

/**
 * Extract social profile URLs
 */
function extractSocialProfiles($) {
  const profiles = [];
  const socialPatterns = [
    { pattern: /facebook\.com/i, name: 'Facebook' },
    { pattern: /twitter\.com|x\.com/i, name: 'Twitter' },
    { pattern: /instagram\.com/i, name: 'Instagram' },
    { pattern: /linkedin\.com/i, name: 'LinkedIn' },
    { pattern: /youtube\.com/i, name: 'YouTube' },
    { pattern: /yelp\.com/i, name: 'Yelp' },
    { pattern: /google\.com\/maps|goo\.gl\/maps/i, name: 'Google' },
    { pattern: /nextdoor\.com/i, name: 'Nextdoor' },
    { pattern: /bbb\.org/i, name: 'BBB' },
    { pattern: /angi\.com|angieslist\.com/i, name: 'Angi' },
    { pattern: /homeadvisor\.com/i, name: 'HomeAdvisor' }
  ];

  $('a[href*="facebook.com"], a[href*="twitter.com"], a[href*="x.com"], a[href*="instagram.com"], a[href*="linkedin.com"], a[href*="youtube.com"], a[href*="yelp.com"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !profiles.includes(href)) {
      profiles.push(href);
    }
  });

  return profiles;
}

/**
 * Extract email from page
 */
function extractEmail($) {
  // Check mailto links
  const mailtoLink = $('a[href^="mailto:"]').first().attr('href');
  if (mailtoLink) {
    return mailtoLink.replace('mailto:', '').split('?')[0];
  }

  // Check meta tags
  const metaEmail = $('meta[name="email"]').attr('content');
  if (metaEmail) return metaEmail;

  // Look for email pattern in text
  const bodyText = $('body').text();
  const emailMatch = bodyText.match(/[\w.-]+@[\w.-]+\.\w{2,}/);
  if (emailMatch) {
    return emailMatch[0];
  }

  return '';
}

/**
 * Detect business type from page content
 */
function detectBusinessType($) {
  const bodyText = $('body').text().toLowerCase();
  const title = $('title').text().toLowerCase();
  const combinedText = title + ' ' + bodyText;

  const businessPatterns = [
    { pattern: /hvac|heating.*cooling|air\s*condition|furnace|heat\s*pump/i, type: 'HVACBusiness' },
    { pattern: /plumb(er|ing)/i, type: 'Plumber' },
    { pattern: /electric(al|ian)/i, type: 'Electrician' },
    { pattern: /roof(er|ing)/i, type: 'RoofingContractor' },
    { pattern: /general\s*contract/i, type: 'GeneralContractor' },
    { pattern: /home\s*(service|repair|improvement)/i, type: 'HomeAndConstructionBusiness' },
    { pattern: /pest\s*control/i, type: 'ProfessionalService' },
    { pattern: /landscap/i, type: 'LandscapingBusiness' },
    { pattern: /clean(ing|er)/i, type: 'ProfessionalService' }
  ];

  for (const { pattern, type } of businessPatterns) {
    if (pattern.test(combinedText)) {
      return type;
    }
  }

  return 'LocalBusiness';
}

/**
 * Fetch a URL and return structured page content for AI extraction.
 * Includes HTML metadata (meta tags, image URLs, link hrefs, JSON-LD)
 * plus prioritized text from header/footer/contact sections.
 */
async function fetchPageText(url, helperConfig) {
  const html = await fetchHtml(url, helperConfig);
  const $ = cheerio.load(html);

  const urlObj = new URL(url);
  const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

  // Helper to resolve relative URLs
  function absUrl(href) {
    if (!href) return '';
    if (href.startsWith('http')) return href;
    try { return new URL(href, baseUrl).href; } catch { return href; }
  }

  // --- 1. Extract HTML metadata that's only in attributes ---
  const meta = [];

  // OG & meta tags
  $('meta[property^="og:"], meta[name="description"], meta[name="author"], meta[property="business:contact_data:phone_number"]').each((_, el) => {
    const prop = $(el).attr('property') || $(el).attr('name');
    const content = $(el).attr('content');
    if (prop && content) meta.push(`${prop}: ${content}`);
  });

  // Logo images (deduplicated)
  const logoSrcs = new Set();
  $('img[class*="logo"], img[alt*="logo" i], .logo img, .site-logo img, .custom-logo, header img').each((_, el) => {
    const src = absUrl($(el).attr('src'));
    if (src) logoSrcs.add(src);
  });
  logoSrcs.forEach(src => meta.push(`Logo image URL: ${src}`));

  // Phone links
  $('a[href^="tel:"]').each((_, el) => {
    meta.push(`Phone: ${$(el).attr('href').replace('tel:', '')}`);
  });

  // Email links
  $('a[href^="mailto:"]').each((_, el) => {
    meta.push(`Email: ${$(el).attr('href').replace('mailto:', '').split('?')[0]}`);
  });

  // Social & directory links (deduplicated)
  const socialHrefs = new Set();
  $('a[href*="facebook.com"], a[href*="twitter.com"], a[href*="x.com"], a[href*="instagram.com"], a[href*="linkedin.com"], a[href*="youtube.com"], a[href*="yelp.com"], a[href*="google.com/maps"], a[href*="goo.gl/maps"], a[href*="nextdoor.com"], a[href*="bbb.org"], a[href*="angi.com"], a[href*="homeadvisor.com"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) socialHrefs.add(href);
  });
  socialHrefs.forEach(href => meta.push(`Social/directory link: ${href}`));

  // Existing JSON-LD schemas (great source of structured org info)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const schema = JSON.parse($(el).html());
      meta.push(`JSON-LD schema: ${JSON.stringify(schema).substring(0, 1500)}`);
    } catch { /* skip invalid */ }
  });

  // --- 2. Extract text from key sections (header, footer, contact) ---
  $('script, style, noscript, svg, iframe').remove();

  const headerText = $('header, .header, #header').text().replace(/\s+/g, ' ').trim();
  const footerText = $('footer, .footer, #footer').text().replace(/\s+/g, ' ').trim();
  const contactText = $('[class*="contact"], [id*="contact"], address, [class*="address"], [itemtype*="PostalAddress"], [itemtype*="LocalBusiness"], [itemtype*="Organization"]')
    .text().replace(/\s+/g, ' ').trim();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  // --- 3. Assemble with budget ---
  const sections = [];
  if (meta.length) sections.push('=== HTML METADATA ===\n' + meta.join('\n'));
  if (headerText) sections.push('=== HEADER ===\n' + headerText.substring(0, 500));
  if (footerText) sections.push('=== FOOTER ===\n' + footerText.substring(0, 1000));
  if (contactText) sections.push('=== CONTACT/ADDRESS SECTIONS ===\n' + contactText.substring(0, 800));

  let result = sections.join('\n\n');
  // Fill remaining budget with general body text
  const remaining = 8000 - result.length;
  if (remaining > 200) {
    result += '\n\n=== PAGE TEXT ===\n' + bodyText.substring(0, remaining - 50);
  }

  return result.substring(0, 8000);
}

module.exports = {
  scrape,
  scrapeOrgInfo,
  fetchPageText
};
