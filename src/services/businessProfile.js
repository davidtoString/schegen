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
  const hours = parseHours(profile.openingHours);
  if (!hours.specification.length) missing.push('opening hours (required on service-area pages)');
  if (hours.unreadable.length) missing.push(`opening hours Schematic can't read: "${hours.unreadable[0]}"`);
  if (!profile.areaServed?.length) recommended.push('service areas');
  if (!profile.sameAs?.length) recommended.push('social / review profile links');
  return { missing, recommended };
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_ALIASES = { mo: 0, mon: 0, monday: 0, tu: 1, tue: 1, tues: 1, tuesday: 1, we: 2, wed: 2, wednesday: 2, th: 3, thu: 3, thur: 3, thurs: 3, thursday: 3, fr: 4, fri: 4, friday: 4, sa: 5, sat: 5, saturday: 5, su: 6, sun: 6, sunday: 6 };
function dayRange(text) {
  const parts = text.toLowerCase().replace(/\./g, '').split(/\s*(?:-|–|—|to|through|thru)\s*/).map(part => DAY_ALIASES[part.trim()]);
  if (parts.some(part => part === undefined)) return null;
  if (parts.length === 1) return [DAYS[parts[0]]];
  const days = [];
  for (let day = parts[0]; ; day = (day + 1) % 7) { days.push(DAYS[day]); if (day === parts[1] || days.length > 7) break; }
  return days;
}
function clock(text) {
  const match = String(text).trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!match) return null;
  let hour = Number(match[1]); const minute = Number(match[2] || 0); const half = match[3]?.[0];
  if (half === 'p' && hour < 12) hour += 12;
  if (half === 'a' && hour === 12) hour = 0;
  if (hour === 24 && !minute) return '23:59';
  return hour <= 23 && minute <= 59 ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : null;
}
/**
 * Opening hours as typed or pasted from Google ("Monday Open 24 hours", "Mon-Fri 8 AM–5 PM",
 * "Saturday Closed", or schema.org's own "Mo-Fr 08:00-17:00") → OpeningHoursSpecification
 * entries, days with identical times grouped. Lines it can't read are returned as `unreadable`.
 */
function parseHours(lines = []) {
  const slots = new Map(); const unreadable = [];
  for (const raw of lines) {
    const line = String(raw).replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z.]+(?:\s*(?:-|–|—|to|through|thru)\s*[A-Za-z.]+)?(?:\s*,\s*[A-Za-z.]+(?:\s*(?:-|–|—)\s*[A-Za-z.]+)?)*)\s*:?\s+(.+)$/);
    const days = match && match[1].split(/\s*,\s*/).map(dayRange);
    if (!days || days.some(day => !day)) { unreadable.push(line); continue; }
    const when = match[2].trim().toLowerCase();
    if (/^closed$/.test(when)) continue;
    let opens; let closes;
    if (/^(open )?24 hours$|^24\/7$|^all day$/.test(when)) { opens = '00:00'; closes = '23:59'; }
    else {
      const times = when.split(/\s*(?:-|–|—|to)\s*/);
      opens = times.length === 2 && clock(times[0]); closes = times.length === 2 && clock(times[1]);
      if (!opens || !closes) { unreadable.push(line); continue; }
    }
    const key = `${opens}-${closes}`;
    slots.set(key, [...new Set([...(slots.get(key) || []), ...days.flat()])]);
  }
  const specification = [...slots].map(([key, days]) => {
    const [opens, closes] = key.split('-');
    return { '@type': 'OpeningHoursSpecification', dayOfWeek: DAYS.filter(day => days.includes(day)), opens, closes };
  });
  return { specification, unreadable };
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

module.exports = { BUSINESS_TYPES, normalize, gaps, detect, parseHours, cityFromTitle, brandFromTitles };
