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
  areaServed: ['Fort Worth', 'Keller'], logo: 'https://stricklandhvac.com/logo.png'
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
  assert.deepEqual(byType.Service.areaServed.map(area => area.name), ['Fort Worth', 'Keller']);
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
  assert.deepEqual(schema['@graph'].find(node => node['@type'] === 'Service').areaServed, [{ '@type': 'City', name: 'Keller, TX' }]);
  assert.ok(!schema['@graph'].some(node => node['@type'] === 'FAQPage'));
  assert.deepEqual(missing, ['FAQPage (no FAQs on this page)']);
});

test('page rules and per-page Types decide what gets built', () => {
  const noFaq = builder.build(repairPage, { siteUrl: SITE, profile, rules: { service: ['Service'] } });
  assert.deepEqual(noFaq.schema['@graph'].map(node => node['@type']).slice(2), ['WebPage', 'Service']);
  const override = builder.build(repairPage, { siteUrl: SITE, profile, plan: { types: ['FAQPage'] } });
  assert.deepEqual(override.schema['@graph'].map(node => node['@type']).slice(2), ['WebPage', 'FAQPage']);
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
  assert.deepEqual(profiles.gaps(found).missing, []);
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
  const saved = await call(`/sites/${site.id}/profile`, 'PUT', { profile, rules: { service: ['Service', 'FAQPage', 'Bogus'] } });
  assert.deepEqual(saved.site.rules.service, ['Service', 'FAQPage']);
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
