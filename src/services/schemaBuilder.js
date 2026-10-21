const { cityFromTitle, parseHours } = require('./businessProfile');

/**
 * Rule-based schema: the business profile + page rules + crawled page → JSON-LD, with no AI.
 * Every page carries the business and WebSite entities (so references always resolve when
 * Rank Math's graph is replaced), a WebPage of the right kind, and the page entities its
 * kind's rule (or the page's own Types override) asks for.
 */

// Page entities the builder can make. The page node, business and WebSite are always included.
const BUILDABLE = ['BreadcrumbList', 'Service', 'FAQPage', 'BlogPosting'];
const KINDS = {
  home: { label: 'Home page', page: 'WebPage', types: ['FAQPage'] },
  service: { label: 'Service page', page: 'WebPage', types: ['BreadcrumbList', 'Service', 'FAQPage'] },
  location: { label: 'Service-area page', page: 'WebPage', types: ['BreadcrumbList', 'Service', 'FAQPage'] },
  hub: { label: 'Listing page', page: 'CollectionPage', types: ['BreadcrumbList'] },
  about: { label: 'About page', page: 'AboutPage', types: ['BreadcrumbList'] },
  contact: { label: 'Contact page', page: 'ContactPage', types: ['BreadcrumbList'] },
  blog: { label: 'Blog post', page: 'WebPage', types: ['BreadcrumbList', 'BlogPosting'] },
  utility: { label: 'Utility page', page: 'WebPage', types: [] }
};

function rulesFor(saved) {
  return Object.fromEntries(Object.keys(KINDS).map(kind => [kind, Array.isArray(saved?.[kind]) ? saved[kind].filter(type => BUILDABLE.includes(type)) : KINDS[kind].types]));
}

function pathOf(url) { try { return new URL(url).pathname.replace(/\/+$/, '') || '/'; } catch { return '/'; } }

/**
 * Sort a page into a kind from its URL, post type and title.
 */
function classify(page, siteUrl) {
  const path = pathOf(page.url).toLowerCase();
  const sitePath = pathOf(siteUrl).toLowerCase();
  if (path === sitePath || path === '/') return 'home';
  if (/(^|\/)(privacy|terms|disclaimer|accessibility|cookie|sitemap|html-sitemap|thank-you|thanks|cart|checkout|my-account|login|careers?|jobs?|reviews?|financing|coupons?|specials?|offers?|gallery|blog|news)(-[\w-]*)?$/.test(path)) {
    return /(^|\/)(blog|news)$/.test(path) ? 'hub' : 'utility';
  }
  if (/(^|\/)(about|about-us|our-team|team|who-we-are|our-story|company)$/.test(path)) return 'about';
  if (/(^|\/)(contact|contact-us|get-in-touch|request-service|schedule|book)(-[\w-]*)?$/.test(path)) return 'contact';
  const postType = page.pageData?.wordpressInfo?.postType || page.postType;
  if (postType === 'post' || /\/(blog|news|articles?)\/./.test(path) || /\/20\d\d\/\d\d\//.test(path)) return 'blog';
  if (/(^|\/)(service-areas?|areas-we-serve|locations?|cities)$/.test(path)) return 'hub';
  if (/(^|\/)(service-areas?|areas-we-serve|locations?|cities)\/./.test(path)) return 'location';
  return 'service';
}

// "AC Repair in Fort Worth, TX | Local AC Experts | Brand" → "AC Repair"
function serviceName(title, h1) {
  let name = String(title || '').split(/\s[|–—]\s|\s-\s/)[0];
  name = name.replace(/\s+(?:in|near|serving|for)\s+(?:the\s+)?[A-Z][\w .,'&-]*$/, '').trim();
  if (!name) name = String(h1 || '').replace(/\s+(?:in|near)\s+[A-Z][\w .,'-]*$/, '').trim();
  return name.slice(0, 120);
}
function pageName(title) { return String(title || '').split(/\s[|–—]\s/)[0].trim(); }
function titleCase(slug) { return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function cityNode(name) { return { '@type': 'City', name }; }
function image(url) { return url ? { '@type': 'ImageObject', url } : undefined; }
function clean(value) {
  if (Array.isArray(value)) { const out = value.map(clean).filter(item => item !== undefined); return out.length ? out : undefined; }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) { const cleaned = clean(item); if (cleaned !== undefined) out[key] = cleaned; }
    return Object.keys(out).length ? out : undefined;
  }
  return value === '' || value === null ? undefined : value;
}

const slug = text => String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/**
 * The one area a page is about: the city in its title ("… in Keller, TX"), else a known
 * area (profile service areas or home city) named in its H1 or URL, else the business's
 * own city. Service.areaServed is always just this, never the business's whole list.
 */
function pageArea(pageData, profile = {}) {
  const region = profile.address?.addressRegion;
  const label = (city, state) => (state || region ? `${city}, ${state || region}` : city);
  const fromTitle = cityFromTitle(pageData.title);
  if (fromTitle) return label(fromTitle.city, fromTitle.state);
  const known = [...new Set([...(profile.areaServed || []), profile.address?.addressLocality].filter(Boolean))]
    .sort((a, b) => b.length - a.length); // "North Richland Hills" before "Richland"
  const h1 = (pageData.headings || []).find(h => h.level === 'h1')?.text || '';
  const path = (() => { try { return new URL(pageData.url).pathname.toLowerCase(); } catch { return ''; } })();
  const named = known.find(city => new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(h1))
    || known.find(city => path.includes(slug(city)));
  if (named) return label(named);
  return profile.address?.addressLocality ? label(profile.address.addressLocality) : '';
}

function businessNode(profile, origin) {
  const a = profile.address || {};
  const hasAddress = a.streetAddress || a.addressLocality || a.postalCode;
  const logo = profile.logo || profile.image;
  return {
    '@type': profile.type || 'LocalBusiness', '@id': `${origin}/#business`, name: profile.name, url: `${origin}/`,
    description: profile.description, telephone: profile.telephone, email: profile.email,
    logo: image(logo), image: profile.image || logo, priceRange: profile.priceRange,
    address: hasAddress ? { '@type': 'PostalAddress', ...a } : undefined,
    openingHoursSpecification: parseHours(profile.openingHours).specification,
    areaServed: profile.areaServed?.map(cityNode), sameAs: profile.sameAs
  };
}

function breadcrumbs(page, origin, pages) {
  const titles = new Map(pages.filter(item => item.title || item.pageData?.title).map(item => [pathOf(item.url), serviceName(item.pageData?.title || item.title)]));
  let trail = Array.isArray(page.breadcrumbs) && page.breadcrumbs.length > 1
    ? page.breadcrumbs.map(crumb => ({ name: crumb.name, url: crumb.url }))
    : null;
  if (!trail) {
    const parts = pathOf(page.url).split('/').filter(Boolean);
    trail = [{ name: 'Home', url: `${origin}/` }, ...parts.map((part, index) => {
      const path = `/${parts.slice(0, index + 1).join('/')}`;
      return { name: titles.get(path) || titleCase(part), url: `${origin}${path}/` };
    })];
    trail[trail.length - 1] = { name: serviceName(page.title) || trail.at(-1).name, url: page.url };
  }
  return trail.filter(crumb => crumb.name && crumb.url).map((crumb, index) => ({ '@type': 'ListItem', position: index + 1, name: crumb.name, item: crumb.url }));
}

/**
 * Build one page's graph. Returns the schema plus page entities that were asked for but had
 * nothing to build from (e.g. FAQPage on a page without FAQs).
 */
function build(pageData, { siteUrl, profile, rules, plan, pages = [] }) {
  const origin = new URL(siteUrl).origin;
  const kind = classify({ url: pageData.url, pageData }, siteUrl);
  const wanted = plan?.types?.length ? plan.types.filter(type => BUILDABLE.includes(type)) : rulesFor(rules)[kind];
  const url = pageData.url;
  const ids = { business: `${origin}/#business`, website: `${origin}/#website`, page: `${url}#webpage`, breadcrumb: `${url}#breadcrumb`, service: `${url}#service`, faq: `${url}#faq`, article: `${url}#article` };
  const graph = [businessNode(profile, origin), {
    '@type': 'WebSite', '@id': ids.website, url: `${origin}/`, name: profile.name, publisher: { '@id': ids.business }, inLanguage: pageData.language || undefined
  }];
  const missing = [];
  const crumbs = wanted.includes('BreadcrumbList') && kind !== 'home' ? breadcrumbs(pageData, origin, pages) : [];
  const pageNode = {
    '@type': KINDS[kind].page, '@id': ids.page, url, name: pageData.title, description: pageData.description,
    inLanguage: pageData.language || undefined, isPartOf: { '@id': ids.website },
    about: ['home', 'about', 'contact'].includes(kind) ? { '@id': ids.business } : undefined,
    breadcrumb: crumbs.length ? { '@id': ids.breadcrumb } : undefined,
    primaryImageOfPage: image(pageData.featuredImage),
    datePublished: Number.isFinite(Date.parse(pageData.publishDate)) ? pageData.publishDate : undefined,
    dateModified: Number.isFinite(Date.parse(pageData.modifiedDate)) ? pageData.modifiedDate : undefined
  };
  graph.push(pageNode);
  if (crumbs.length) graph.push({ '@type': 'BreadcrumbList', '@id': ids.breadcrumb, itemListElement: crumbs });

  if (wanted.includes('Service')) {
    const name = serviceName(pageData.title, pageData.headings?.find(h => h.level === 'h1')?.text);
    const area = pageArea(pageData, profile);
    const areaServed = area ? cityNode(area) : undefined;
    if (name) {
      graph.push({ '@type': 'Service', '@id': ids.service, name, serviceType: name, description: pageData.description, url, provider: { '@id': ids.business }, areaServed, image: pageData.featuredImage || undefined, mainEntityOfPage: { '@id': ids.page } });
      pageNode.mainEntity = { '@id': ids.service };
    } else missing.push('Service (the page has no usable title)');
  }
  if (wanted.includes('FAQPage')) {
    const faqs = (pageData.faqs || []).filter(faq => faq?.question && faq?.answer);
    if (faqs.length) graph.push({ '@type': 'FAQPage', '@id': ids.faq, url, isPartOf: { '@id': ids.website }, mainEntity: faqs.map(faq => ({ '@type': 'Question', name: faq.question.trim(), acceptedAnswer: { '@type': 'Answer', text: faq.answer.trim() } })) });
    else missing.push('FAQPage (no FAQs on this page)');
  }
  if (wanted.includes('BlogPosting')) {
    graph.push({
      '@type': 'BlogPosting', '@id': ids.article, headline: pageName(pageData.title).slice(0, 110), description: pageData.description, url,
      datePublished: pageNode.datePublished, dateModified: pageNode.dateModified, image: pageData.featuredImage || undefined,
      author: pageData.author ? { '@type': 'Person', name: pageData.author } : { '@id': ids.business },
      publisher: { '@id': ids.business }, mainEntityOfPage: { '@id': ids.page }
    });
  }
  const schema = { '@context': 'https://schema.org', '@graph': graph.map(clean) };
  return { schema, missing, kind, errors: siteRuleErrors(schema, kind) };
}

const isBusinessNode = node => [].concat(node?.['@type'] || []).some(type => type === 'Organization' || /Business|Contractor|Plumber|Electrician|Locksmith|Painter|Store|Restaurant|Dentist|Service$/.test(type) && type !== 'Service');

// Rules every page must meet, whichever engine built it.
function siteRuleErrors(schema, kind) {
  const errors = [];
  if (kind === 'location') {
    const business = (schema['@graph'] || []).find(isBusinessNode);
    if (!business?.openingHoursSpecification?.length && !business?.openingHours) errors.push('Service-area pages need opening hours. Add them in Business profile (for example "Monday-Friday 8 AM-5 PM").');
  }
  return errors;
}

/**
 * Apply the site rules to a graph from any engine (used on AI output): each Service serves only
 * the page's own area, and the business carries the profile's opening hours. A service-area
 * page always gets the business entity, so its hours are on the page.
 */
function enforceSiteRules(schema, pageData, { siteUrl, profile }) {
  const kind = classify({ url: pageData.url, pageData }, siteUrl);
  if (!profile?.name) return { schema, kind, errors: siteRuleErrors(schema, kind) };
  const graph = [...(schema['@graph'] || [])];
  const area = pageArea(pageData, profile);
  for (const node of graph) {
    if ([].concat(node['@type'] || []).includes('Service')) { if (area) node.areaServed = cityNode(area); else delete node.areaServed; }
  }
  const hours = parseHours(profile.openingHours).specification;
  let business = graph.find(isBusinessNode);
  if (business && hours.length) { business.openingHoursSpecification = hours; delete business.openingHours; }
  if (!business && kind === 'location') graph.unshift(clean(businessNode(profile, new URL(siteUrl).origin)));
  const result = { ...schema, '@graph': graph };
  return { schema: result, kind, errors: siteRuleErrors(result, kind) };
}

/**
 * What Google needs per type. errors make the graph unusable; warnings only cost features.
 * Business-profile gaps are reported once on the profile, so `skipBusiness` leaves them out here.
 */
function completeness(schema, { skipBusiness = false } = {}) {
  const errors = []; const warnings = [];
  for (const node of Array.isArray(schema?.['@graph']) ? schema['@graph'] : []) {
    if (!node || typeof node !== 'object') continue;
    const types = [].concat(node['@type'] || []);
    const has = type => types.includes(type);
    if (has('FAQPage')) {
      const questions = [].concat(node.mainEntity || []);
      if (!questions.length) errors.push('FAQPage has no questions.');
      if (questions.some(q => !q?.name || !q?.acceptedAnswer?.text)) errors.push('Every FAQ needs a question and an answer.');
    }
    if (has('BreadcrumbList') && ![].concat(node.itemListElement || []).every(item => item?.position && item?.name && item?.item)) errors.push('Breadcrumb items need a position, name and URL.');
    if (has('Service')) {
      if (!node.name) errors.push('Service needs a name.');
      if (!node.provider) warnings.push('Service has no provider (the business).');
      if (!node.areaServed) warnings.push('Service has no area served.');
    }
    if (has('BlogPosting') || has('Article')) {
      if (!node.headline) errors.push(`${types[0]} needs a headline.`);
      if (!node.image) warnings.push(`${types[0]} has no image (needed for article rich results).`);
      if (!node.datePublished) warnings.push(`${types[0]} has no publish date.`);
    }
    const isBusiness = types.some(type => type === 'Organization' || /Business|Contractor|Plumber|Electrician|Service$/.test(type)) && !has('Service');
    if (isBusiness && !skipBusiness) {
      if (!node.name) errors.push(`${types[0]} needs a name.`);
      if (!node.address?.streetAddress || !node.address?.postalCode) warnings.push(`${types[0]} has no full street address (Google needs one for local business results).`);
      if (!node.telephone) warnings.push(`${types[0]} has no phone number.`);
    }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

module.exports = { BUILDABLE, KINDS, rulesFor, classify, build, completeness, serviceName, pageArea, enforceSiteRules };
