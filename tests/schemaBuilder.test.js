const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { once } = require('node:events');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'schematic-builder-'));
process.env.APP_SECRET = 'test-only';
process.env.CRAWL_INTERVAL_MS = '0';
const builder = require('../src/services/schemaBuilder');
const profiles = require('../src/services/businessProfile');
const store = require('../src/services/workspaceStore');
const schemaService = require('../src/services/pageSchema');

const SITE = 'https://stricklandhvac.com';
const profile = profiles.normalize({
  type: 'HVACBusiness', name: 'Strickland Heating and Air', telephone: '(817) 476-1950',
  address: { streetAddress: '100 Main St', addressLocality: 'Fort Worth', addressRegion: 'TX', postalCode: '76107' },
  areaServed: ['Fort Worth', 'Keller', 'North Richland Hills'], logo: 'https://stricklandhvac.com/logo.png',
  openingHours: ['Monday Open 24 hours', 'Tuesday Open 24 hours', 'Wednesday Open 24 hours', 'Thursday Open 24 hours', 'Friday Open 24 hours', 'Saturday Open 24 hours', 'Sunday Open 24 hours']
});
const repairPage = {
  url: `${SITE}/furnace-services-fort-worth-tx/repair/`,
  title: 'Furnace Repair in Fort Worth, TX | Fast Furnace Repair Service & Technicians | Strickland Heating and Air',
  description: 'Fast furnace repair in Fort Worth.', content: 'We repair furnaces.',
  headings: [{ level: 'h1', text: 'Get Trusted Furnace Repair in Fort Worth Before It Worsens' }],
  faqs: [{ question: 'Do you repair all brands?', answer: 'Yes, every major brand.' }],
  wordpressInfo: { postType: 'page' }
};

test('pages are sorted into kinds from their URL and post type', () => {
  const kind = url => builder.classify({ url: SITE + url }, SITE);
  assert.equal(kind('/'), 'home');
  assert.equal(kind('/furnace-services-fort-worth-tx/repair/'), 'service');
  assert.equal(kind('/service-areas/columbus-ms-hvac-services/'), 'location');
  assert.equal(kind('/service-areas/'), 'hub');
  assert.equal(kind('/about-us/'), 'about');
  assert.equal(kind('/contact-us/'), 'contact');
  assert.equal(kind('/privacy-policy/'), 'utility');
  assert.equal(kind('/html-sitemap/'), 'utility');
  assert.equal(builder.classify({ url: `${SITE}/hello-world/`, pageData: { wordpressInfo: { postType: 'post' } } }, SITE), 'blog');
});

test('service names come from the title, not the marketing headline', () => {
  assert.equal(builder.serviceName(repairPage.title), 'Furnace Repair');
  assert.equal(builder.serviceName('AC Tune Ups in Fort Worth, TX | Home AC Unit Tune Up Services | Strickland'), 'AC Tune Ups');
  assert.equal(builder.serviceName('HVAC Services in the Golden Triangle | Local HVAC Company'), 'HVAC Services');
});

test('a service page gets business, website, page, breadcrumbs, service and FAQs, fully linked and valid', () => {
  const { schema, missing, kind } = builder.build(repairPage, { siteUrl: SITE, profile, pages: [{ url: `${SITE}/furnace-services-fort-worth-tx/`, title: 'Furnace Services in Fort Worth, TX | Strickland' }] });
  assert.equal(kind, 'service');
  assert.deepEqual(missing, []);
  const byType = Object.fromEntries(schema['@graph'].map(node => [[].concat(node['@type'])[0], node]));
  assert.deepEqual(Object.keys(byType), ['HVACBusiness', 'WebSite', 'WebPage', 'BreadcrumbList', 'Service', 'FAQPage']);
  assert.equal(byType.Service.name, 'Furnace Repair');
  assert.deepEqual(byType.Service.provider, { '@id': `${SITE}/#business` });
  assert.deepEqual(byType.Service.areaServed, { '@type': 'City', name: 'Fort Worth, TX' }, 'only the page\'s own area');
  assert.deepEqual(byType.HVACBusiness.openingHoursSpecification, [{ '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], opens: '00:00', closes: '23:59' }]);
  assert.equal(byType.HVACBusiness.openingHours, undefined, 'free-text hours are never output');
  assert.deepEqual(byType.BreadcrumbList.itemListElement.map(item => item.name), ['Home', 'Furnace Services', 'Furnace Repair']);
  assert.equal(byType.FAQPage.mainEntity[0].acceptedAnswer.text, 'Yes, every major brand.');
  assert.equal(byType.HVACBusiness.address.postalCode, '76107');
  const validation = schemaService.validate(schema, repairPage, { skipBusiness: true });
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.warnings, []);
  // Every internal reference resolves to a node in the graph.
  const ids = new Set(schema['@graph'].map(node => node['@id']));
  const refs = JSON.stringify(schema).match(/\{"@id":"[^"]+"\}/g).map(ref => JSON.parse(ref)['@id']);
  assert.ok(refs.every(id => ids.has(id)), 'all refs resolve');
});

test('service-area pages serve their own city; missing FAQs are reported, not invented', () => {
  const page = { url: `${SITE}/service-areas/keller-tx-hvac-services/`, title: 'HVAC Services in Keller, TX | Strickland Heating and Air', content: 'x' };
  const { schema, missing, kind } = builder.build(page, { siteUrl: SITE, profile });
  assert.equal(kind, 'location');
  assert.deepEqual(schema['@graph'].find(node => node['@type'] === 'Service').areaServed, { '@type': 'City', name: 'Keller, TX' });
  assert.ok(schema['@graph'][0].openingHoursSpecification.length, 'service-area pages carry the hours');
  assert.ok(!schema['@graph'].some(node => node['@type'] === 'FAQPage'));
  assert.deepEqual(missing, ['FAQPage (no FAQs on this page)']);
});

test('page rules and per-page Types decide what gets built', () => {
  const noFaq = builder.build(repairPage, { siteUrl: SITE, profile, rules: { service: ['Service'] } });
  assert.deepEqual(noFaq.schema['@graph'].map(node => node['@type']).slice(2), ['WebPage', 'Service']);
  const override = builder.build(repairPage, { siteUrl: SITE, profile, plan: { types: ['HVACBusiness', 'FAQPage'] } });
  assert.deepEqual(override.schema['@graph'].map(node => node['@type']), ['HVACBusiness', 'WebSite', 'WebPage', 'FAQPage'], 'the profile\'s business type selects the business');
});

test('completeness flags what Google needs', () => {
  const broken = { '@graph': [{ '@type': 'FAQPage', mainEntity: [] }, { '@type': 'HVACBusiness', name: 'X' }, { '@type': 'Service' }] };
  const result = builder.completeness(broken);
  assert.ok(result.errors.includes('FAQPage has no questions.'));
  assert.ok(result.errors.includes('Service needs a name.'));
  assert.ok(result.warnings.some(w => /street address/.test(w)));
  assert.ok(!builder.completeness(broken, { skipBusiness: true }).warnings.some(w => /street address/.test(w)));
});

test('profile detection reads titles, homepage footer, phone, logo and social links', () => {
  const homepageHtml = `<html><body><header><img class="custom-logo" src="/logo.png"></header><a href="tel:+18174761950">Call</a>
    <a href="https://www.facebook.com/strickland">fb</a><footer>Strickland Heating and Air, 2700 W 7th St, Suite 100, Fort Worth, TX 76107</footer></body></html>`;
  const pages = [repairPage, { ...repairPage, url: `${SITE}/ac/`, title: 'AC Repair in Fort Worth, TX | AC | Strickland Heating and Air', serviceAreas: ['Keller'] }].map(pageData => ({ url: pageData.url, pageData: { ...pageData, existingSchema: [] } }));
  const found = profiles.detect({ siteUrl: SITE, homepageHtml, pages });
  assert.equal(found.name, 'Strickland Heating and Air');
  assert.equal(found.type, 'HVACBusiness');
  assert.equal(found.telephone, '+18174761950');
  assert.equal(found.logo, `${SITE}/logo.png`);
  assert.deepEqual(found.address, { streetAddress: '2700 W 7th St, Suite 100', addressLocality: 'Fort Worth', addressRegion: 'TX', postalCode: '76107', addressCountry: 'US' });
  assert.deepEqual(found.sameAs, ['https://www.facebook.com/strickland']);
  assert.ok(found.areaServed.includes('Keller') && found.areaServed.includes('Fort Worth'));
  assert.deepEqual(profiles.gaps(found).missing, ['opening hours (required on service-area pages)'], 'hours are not on this homepage, so they are flagged');
});

test('rules engine needs a saved profile, then builds pages with no AI key', async t => {
  const routes = require('../src/routes/workspaces');
  const app = express(); app.use(express.json()); app.use('/api', routes);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const api = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (url, method = 'GET', body) => { const response = await fetch(api + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { code: response.status, ...(await response.json()) }; };
  const site = store.createSite({ name: 'Strickland', url: SITE });
  const run = store.createRun(site.id);
  store.updateRun(run.id, { status: 'ready', pages: [{ url: repairPage.url, status: 'crawled', pageData: repairPage }] });
  assert.match((await call(`/runs/${run.id}/generate`, 'POST', { urls: [repairPage.url] })).error, /business profile/);
  assert.equal((await call(`/sites/${site.id}/profile`, 'PUT', { profile: { name: '' } })).code, 400);
  const saved = await call(`/sites/${site.id}/profile`, 'PUT', { profile, rules: { service: ['LocalBusiness', 'Service', 'FAQPage', 'Bogus'] } });
  assert.deepEqual(saved.site.rules.service, ['LocalBusiness', 'Service', 'FAQPage']);
  assert.deepEqual(saved.site.profileGaps.missing, []);
  assert.equal((await call(`/runs/${run.id}/generate`, 'POST', { urls: [repairPage.url] })).code, 202);
  for (let i = 0; i < 100 && store.getRun(run.id).status === 'generating'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const page = store.getRun(run.id).pages[0];
  assert.equal(page.status, 'generated', JSON.stringify(page.validation));
  assert.equal(page.generation.engine, 'rules');
  assert.deepEqual(page.schemaTypes, ['HVACBusiness', 'WebSite', 'WebPage', 'Service', 'FAQPage']);
  assert.equal((await call(`/runs/${run.id}`)).run.pages[0].kind, 'service');
});

test('detection keeps an agency an Organization and turns link texts into city names', () => {
  const agency = profiles.detect({ siteUrl: 'https://agency.test', pages: [{ url: 'https://agency.test/hvac-marketing/', pageData: { title: 'HVAC Marketing | Agency', existingSchema: [{ '@graph': [{ '@type': ['Corporation', 'Organization'], name: 'The Agency' }] }] } }] });
  assert.equal(agency.type, 'Organization');
  const beacon = profiles.detect({ siteUrl: 'https://b.test', pages: [{ url: 'https://b.test/a/', pageData: { title: 'AC Repair in Starkville, MS | Beacon', serviceAreas: ['Service Areas', 'West Point', 'HVAC Services in Columbus, MS', 'HVAC Services in the Golden Triangle'] } }] });
  assert.deepEqual(beacon.areaServed, ['West Point', 'Columbus', 'Starkville']);
});

test('opening hours: Google wording, ranges, closed days and schema.org format', () => {
  const { specification, unreadable } = profiles.parseHours(['Mon-Fri 8 AM–5 PM', 'Saturday: 9am - 1pm', 'Sunday Closed', 'Mo-Fr 08:00-17:00', 'whenever']);
  assert.deepEqual(specification, [
    { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], opens: '08:00', closes: '17:00' },
    { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Saturday'], opens: '09:00', closes: '13:00' }
  ]);
  assert.deepEqual(unreadable, ['whenever']);
  assert.ok(profiles.gaps({ ...profile, openingHours: ['whenever'] }).missing.some(gap => /can't read/.test(gap)));
  assert.ok(profiles.gaps({ ...profile, openingHours: [] }).missing.some(gap => /opening hours/.test(gap)));
});

test('a service page serves only its own area: title city, else a known area in the H1 or URL, else the home city', () => {
  const area = page => builder.pageArea({ url: `${SITE}/x/`, ...page }, profile);
  assert.equal(area({ title: 'AC Repair in Keller, TX | Strickland' }), 'Keller, TX');
  assert.equal(area({ title: 'AC Repair | Strickland', headings: [{ level: 'h1', text: 'Fast AC repair for North Richland Hills homes' }] }), 'North Richland Hills, TX');
  assert.equal(area({ title: 'AC Repair | Strickland', url: `${SITE}/ac-repair-keller/` }), 'Keller, TX');
  assert.equal(area({ title: 'AC Repair | Strickland' }), 'Fort Worth, TX');
});

test('service-area pages without opening hours cannot be published', () => {
  const page = { url: `${SITE}/service-areas/keller-tx-hvac-services/`, title: 'HVAC Services in Keller, TX | Strickland', content: 'x' };
  const { errors } = builder.build(page, { siteUrl: SITE, profile: { ...profile, openingHours: [] } });
  assert.match(errors[0], /opening hours/);
  assert.deepEqual(builder.build(page, { siteUrl: SITE, profile }).errors, []);
});

test('AI output gets the same site rules: own-area Service and the business with hours on service-area pages', () => {
  const page = { url: `${SITE}/service-areas/keller-tx-hvac-services/`, title: 'HVAC Services in Keller, TX | Strickland', content: 'x' };
  const ai = { '@context': 'https://schema.org', '@graph': [{ '@type': 'Service', name: 'HVAC Services', areaServed: ['Keller', 'Weatherford', 'Azle'] }] };
  const { schema, errors, kind } = builder.enforceSiteRules(ai, page, { siteUrl: SITE, profile });
  assert.equal(kind, 'location');
  assert.deepEqual(errors, []);
  assert.deepEqual(schema['@graph'].find(node => node['@type'] === 'Service').areaServed, { '@type': 'City', name: 'Keller, TX' });
  assert.ok(schema['@graph'].find(node => node['@type'] === 'HVACBusiness').openingHoursSpecification.length);
});

test('on service and service-area pages every areaServed is the page area, the business included; other pages keep the full list', () => {
  const saginaw = { url: `${SITE}/service-areas/saginaw-tx-hvac-services/`, title: 'HVAC Services in Saginaw, TX | Strickland', content: 'x' };
  const built = builder.build(saginaw, { siteUrl: SITE, profile });
  assert.deepEqual(built.schema['@graph'][0].areaServed, { '@type': 'City', name: 'Saginaw, TX' });
  const ai = { '@graph': [{ '@type': 'FAQPage', mainEntity: [] }, { '@type': 'HVACBusiness', name: 'Strickland', areaServed: [{ '@type': 'City', name: 'Saginaw' }, { '@type': 'City', name: 'Keller' }, { '@type': 'City', name: 'Azle' }] }] };
  const fixed = builder.enforceSiteRules(ai, saginaw, { siteUrl: SITE, profile }).schema;
  assert.deepEqual(fixed['@graph'][1].areaServed, { '@type': 'City', name: 'Saginaw, TX' });
  const home = builder.build({ url: `${SITE}/`, title: 'Strickland Heating and Air', content: 'x' }, { siteUrl: SITE, profile });
  assert.equal(home.schema['@graph'][0].areaServed.length, 3, 'the home page keeps every area');
});

test('the business entity is a selectable rule type: on by default, kept for old rules, required on service-area pages', () => {
  assert.ok(builder.rulesFor(undefined).service.includes('LocalBusiness'), 'on by default');
  assert.ok(builder.rulesFor({ service: ['Service'] }).service.includes('LocalBusiness'), 'rules saved before it was selectable keep it');
  const saved = builder.saveRules({ service: ['Service', 'FAQPage'], location: ['FAQPage'] });
  assert.deepEqual(builder.rulesFor(saved).service, ['Service', 'FAQPage'], 'switched off when unticked in new rules');
  assert.deepEqual(builder.rulesFor(saved).location, ['LocalBusiness', 'FAQPage'], 'service-area pages always keep it');

  const off = builder.build(repairPage, { siteUrl: SITE, profile, rules: saved });
  assert.ok(!off.schema['@graph'].some(node => node['@type'] === 'HVACBusiness'));
  assert.ok(!JSON.stringify(off.schema).includes('#business'), 'no links left pointing at the missing business');
  const keller = builder.build({ url: `${SITE}/service-areas/keller-tx-hvac-services/`, title: 'HVAC Services in Keller, TX | Strickland', content: 'x' }, { siteUrl: SITE, profile, rules: saved, plan: { types: ['FAQPage'] } });
  assert.equal(keller.schema['@graph'][0]['@type'], 'HVACBusiness', 'even a Types override cannot remove it from service-area pages');
});
