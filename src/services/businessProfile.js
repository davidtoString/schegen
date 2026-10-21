const cheerio = require('cheerio');

// Common LocalBusiness types for trades; any schema.org type name is accepted.
const BUSINESS_TYPES = ['HVACBusiness', 'Plumber', 'Electrician', 'RoofingContractor', 'GeneralContractor', 'HomeAndConstructionBusiness', 'LocalBusiness', 'ProfessionalService', 'Organization'];
const SOCIAL_HOSTS = /(^|\.)(facebook|instagram|linkedin|youtube|x|twitter|tiktok|pinterest|yelp|bbb|nextdoor|angi|homeadvisor|houzz|thumbtack)\.(com|org)$/i;

const text = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const list = (value, max = 60) => [...new Set((Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/)).map(item => text(item, 200)).filter(Boolean))].slice(0, max);
function httpsUrl(value) {
  const raw = text(value, 2000);
  if (!raw) return '';
  try { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}

/**
 * Clean a profile from the UI or detection. Unknown fields are dropped.
 */
function normalize(input = {}) {
  const address = input.address || {};
  return {
    type: /^[A-Z][A-Za-z]{1,60}$/.test(input.type || '') ? input.type : 'LocalBusiness',
    name: text(input.name, 150),
    description: text(input.description, 600),
    telephone: text(input.telephone, 40),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(input.email)) ? text(input.email) : '',
    logo: httpsUrl(input.logo),
    image: httpsUrl(input.image),
    priceRange: text(input.priceRange, 20),
    address: {
      streetAddress: text(address.streetAddress, 150),
      addressLocality: text(address.addressLocality, 80),
      addressRegion: text(address.addressRegion, 40),
      postalCode: text(address.postalCode, 20),
      addressCountry: text(address.addressCountry || 'US', 40)
    },
    openingHours: list(input.openingHours, 14).map(line => line.slice(0, 60)),
    areaServed: list(input.areaServed),
    sameAs: list(input.sameAs, 20).map(httpsUrl).filter(Boolean)
  };
}

/**
 * What the profile still lacks, split into what breaks local results and what only helps.
 */
function gaps(profile) {
  if (!profile?.name) return { missing: ['business name'], recommended: [] };
  const a = profile.address || {};
  const missing = [];
  if (!a.streetAddress || !a.addressLocality || !a.addressRegion || !a.postalCode) missing.push('full street address');
  const recommended = [];
  if (!profile.telephone) recommended.push('phone');
  if (!profile.logo && !profile.image) recommended.push('logo or photo');
  if (!profile.openingHours?.length) recommended.push('opening hours');
  if (!profile.areaServed?.length) recommended.push('service areas');
  if (!profile.sameAs?.length) recommended.push('social / review profile links');
  return { missing, recommended };
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}
// "AC Repair in Fort Worth, TX | …" → { city: 'Fort Worth', state: 'TX' }
function cityFromTitle(title) {
  const match = String(title || '').match(/\b(?:in|near|serving)\s+([A-Z][A-Za-z .'-]+?),\s*([A-Z]{2})\b/);
  return match ? { city: match[1].trim(), state: match[2] } : null;
}
// The brand is the segment most titles end with ("… | Strickland Heating and Air").
function brandFromTitles(titles) {
  return mostCommon(titles.map(title => String(title || '').split(/\s[|–—-]\s/)).filter(parts => parts.length > 1).map(parts => parts.at(-1).trim()));
}

// Crawled "service areas" are link texts: keep the city ("HVAC Services in Columbus, MS" → "Columbus"), drop headings.
function areaName(value) {
  const raw = String(value || '').trim();
  const city = cityFromTitle(raw);
  if (city) return city.city;
  if (raw.length > 30 || /\b(service|services|areas?|hvac|heating|cooling|repair|near you|golden triangle|contact|call)\b/i.test(raw)) return '';
  return raw;
}
const decodeEntities = value => String(value || '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#8217;/g, '’').replace(/&#8211;/g, '–');

function businessNodes(schemas) {
  const nodes = [];
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    const types = [].concat(value['@type'] || []);
    if (types.some(type => type === 'Organization' || type === 'Corporation' || /Business|Contractor|Plumber|Electrician|Service$|Store|Restaurant/.test(type))) nodes.push(value);
    Object.values(value).forEach(walk);
  };
  walk(schemas);
  return nodes;
}

function fromHomepage(html, siteUrl) {
  const $ = cheerio.load(html || '');
  const found = { sameAs: [] };
  found.name = $('meta[property="og:site_name"]').attr('content') || '';
  const logo = $('img.custom-logo, .custom-logo-link img, header img[class*="logo" i], header img[alt*="logo" i], img[class*="logo" i]').first();
  const logoSrc = logo.attr('data-src') || logo.attr('src');
  if (logoSrc) try { found.logo = new URL(logoSrc, siteUrl).href; } catch { /* Bad URL. */ }
  found.image = $('meta[property="og:image"]').attr('content') || '';
  const tel = $('a[href^="tel:"]').first().attr('href');
  if (tel) found.telephone = decodeURIComponent(tel.slice(4)).trim();
  const mail = $('a[href^="mailto:"]').first().attr('href');
  if (mail) found.email = mail.slice(7).split('?')[0];
  $('a[href]').each((_, el) => {
    try { const url = new URL($(el).attr('href'), siteUrl); if (SOCIAL_HOSTS.test(url.hostname.replace(/^www\./, '')) && url.pathname.length > 1) found.sameAs.push(url.href); } catch { /* Not a URL. */ }
  });
  // "1234 Main St, Suite 5, Fort Worth, TX 76107" in the visible text (usually the footer).
  const body = $('body').text().replace(/\s+/g, ' ');
  const address = body.match(/(\d{1,6}\s+[A-Za-z0-9.#' -]{3,60}?\b(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Hwy|Highway|Pkwy|Parkway|Way|Ct|Court|Pl|Place|Cir|Circle|Trl|Trail|Fwy|Freeway)\.?(?:,?\s*(?:Suite|Ste\.?|Unit|#)\s*[\w-]+)?),\s*([A-Z][A-Za-z .'-]+?),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/);
  if (address) found.address = { streetAddress: address[1].trim(), addressLocality: address[2].trim(), addressRegion: address[3], postalCode: address[4] };
  return found;
}

/**
 * Best-guess profile from the site: existing JSON-LD on crawled pages wins, then the homepage
 * (logo, phone, social links, footer address), then page titles (brand, main city) and the
 * crawler's service-area list. Everything is a suggestion for the user to confirm.
 */
function detect({ siteUrl, homepageHtml, siteName, pages = [] }) {
  const crawled = pages.filter(page => page.pageData);
  const nodes = businessNodes(crawled.map(page => page.pageData.existingSchema || []));
  const node = nodes.find(item => item.address) || nodes[0] || {};
  const home = fromHomepage(homepageHtml, siteUrl);
  const titles = crawled.map(page => page.pageData.title || page.title);
  const cities = titles.map(cityFromTitle).filter(Boolean);
  const mainCity = mostCommon(cities.map(item => `${item.city}|${item.state}`)).split('|');
  const nodeAddress = typeof node.address === 'object' ? [].concat(node.address)[0] : {};
  const logo = typeof node.logo === 'string' ? node.logo : node.logo?.url || node.logo?.contentUrl;
  const telephone = node.telephone || [].concat(node.contactPoint || [])[0]?.telephone || home.telephone || crawled.map(page => String(page.pageData.phone || '').match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0]).find(Boolean);
  const areas = [...new Set([
    ...[].concat(node.areaServed || []).map(area => typeof area === 'string' ? area : area?.name),
    ...crawled.flatMap(page => page.pageData.serviceAreas || []).map(areaName),
    ...cities.map(item => item.city)
  ].filter(Boolean))];
  const allText = crawled.map(page => `${page.pageData.title} ${page.pageData.description}`).join(' ').toLowerCase();
  // A site that already calls itself a plain Organization (an agency, say) isn't guessed into a trade.
  const nodeTypes = [].concat(node['@type'] || []);
  const type = nodeTypes.find(item => item !== 'Organization' && item !== 'Corporation') || (nodeTypes.length ? 'Organization' : '') ||
    (/hvac|heating|air condition|furnace|heat pump/.test(allText) ? 'HVACBusiness' : /plumb/.test(allText) ? 'Plumber' : /electric/.test(allText) ? 'Electrician' : /roof/.test(allText) ? 'RoofingContractor' : 'LocalBusiness');
  return normalize({
    type,
    name: node.name || brandFromTitles(titles) || decodeEntities(home.name) || decodeEntities(siteName),
    description: node.description || '',
    telephone,
    email: node.email || home.email,
    logo: logo || home.logo,
    image: (typeof node.image === 'string' ? node.image : node.image?.url) || home.image,
    priceRange: node.priceRange,
    address: {
      streetAddress: nodeAddress?.streetAddress || home.address?.streetAddress,
      addressLocality: nodeAddress?.addressLocality || home.address?.addressLocality || mainCity[0],
      addressRegion: nodeAddress?.addressRegion || home.address?.addressRegion || mainCity[1],
      postalCode: nodeAddress?.postalCode || home.address?.postalCode,
      addressCountry: (typeof nodeAddress?.addressCountry === 'string' ? nodeAddress.addressCountry : nodeAddress?.addressCountry?.name) || 'US'
    },
    openingHours: [].concat(node.openingHours || []),
    areaServed: areas,
    sameAs: [...new Set([...[].concat(node.sameAs || []), ...home.sameAs])]
  });
}

module.exports = { BUSINESS_TYPES, normalize, gaps, detect, cityFromTitle, brandFromTitles };
