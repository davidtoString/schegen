const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { once } = require('node:events');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'schematic-features-'));
process.env.APP_SECRET = 'test-only';
process.env.OPENAI_API_KEY = 'fixture-only-not-a-real-key';
process.env.CRAWL_INTERVAL_MS = '0';
const scraper = require('../src/services/pageScraper');
const sitemap = require('../src/services/sitemapParser');
const schemaService = require('../src/services/pageSchema');
const routes = require('../src/routes/workspaces');

async function serve(app, t) {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
const PAGE = '<html><head><title>AC Repair</title></head><body><main><h1>AC Repair</h1><p>We repair air conditioners in Starkville.</p></main></body></html>';

test('a CDN that blocks fake browsers still lets the crawler through, and vice versa', async t => {
  const app = express();
  app.get('/blocks-browsers', (req, res) => /Chrome/.test(req.get('user-agent') || '') ? res.sendStatus(403) : res.send(PAGE));
  app.get('/blocks-crawlers', (req, res) => /Schematic|axios/.test(req.get('user-agent') || '') ? res.sendStatus(403) : res.send(PAGE));
  const origin = await serve(app, t);
  assert.equal((await scraper.scrape(`${origin}/blocks-browsers`)).title, 'AC Repair');
  assert.equal((await scraper.scrape(`${origin}/blocks-crawlers`)).title, 'AC Repair');
});

test('sitemaps: robots.txt discovery, redirects followed, one broken child sitemap tolerated', async t => {
  let origin;
  const app = express();
  app.get('/robots.txt', (req, res) => res.type('text').send(`User-agent: *\nSitemap: ${origin}/custom/sitemap.xml`));
  app.get('/custom/sitemap.xml', (req, res) => res.redirect(301, '/custom/index.xml'));
  app.get('/custom/index.xml', (req, res) => res.type('xml').send(`<sitemapindex><sitemap><loc>${origin}/page-sitemap.xml</loc></sitemap><sitemap><loc>${origin}/broken-sitemap.xml</loc></sitemap></sitemapindex>`));
  app.get('/page-sitemap.xml', (req, res) => res.type('xml').send(`<urlset><url><loc>${origin}/a/</loc></url><url><loc>${origin}/b/</loc></url></urlset>`));
  app.get('/broken-sitemap.xml', (req, res) => res.sendStatus(404));
  origin = await serve(app, t);
  const found = await sitemap.findSitemap(origin);
  assert.equal(found, `${origin}/custom/index.xml`);
  const context = { visited: new Set(), depth: 0, maxDepth: 6, maxUrls: 5000, origin, warnings: [] };
  assert.deepEqual(await sitemap.parse(`${origin}/custom/sitemap.xml`, 'all', context), [`${origin}/a/`, `${origin}/b/`]);
  assert.equal(context.warnings.length, 1);
  assert.ok(sitemap.sameSite('https://www.example.com/x', 'https://example.com'));
});

test('schema plans keep only chosen types and prune references to entities that do not exist', () => {
  const page = { url: 'https://example.com/ac/', title: 'AC', content: 'AC repair.', existingSchema: [{ '@graph': [{ '@type': 'Organization', '@id': 'https://example.com/#organization' }] }] };
  const generated = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebPage', '@id': 'https://example.com/ac/#webpage', url: page.url },
    { '@type': 'HVACBusiness', '@id': 'https://example.com/#business', name: 'Acme', telephone: '' },
    { '@type': 'Service', '@id': 'https://example.com/ac/#service', name: 'AC Repair', url: page.url, provider: { '@id': 'https://example.com/#business' }, isPartOf: { '@id': 'https://example.com/ac/#webpage' }, brand: { '@id': 'https://example.com/#organization' }, sameAs: { '@id': 'https://other.example/#thing' } },
    { name: 'no type' }
  ] };
  const { schema, missing } = schemaService.applyPlan(generated, { types: ['Service', 'LocalBusiness', 'FAQPage'] }, page);
  assert.deepEqual(schema['@graph'].map(node => node['@type']), ['HVACBusiness', 'Service']);
  const service = schema['@graph'][1];
  assert.deepEqual(service.provider, { '@id': 'https://example.com/#business' }, 'ref to a kept node stays');
  assert.equal(service.isPartOf, undefined, 'ref to a dropped node is pruned');
  assert.deepEqual(service.brand, { '@id': 'https://example.com/#organization' }, 'ref to existing Rank Math entity stays');
  assert.deepEqual(service.sameAs, { '@id': 'https://other.example/#thing' }, 'external refs untouched');
  assert.equal(schema['@graph'][0].telephone, undefined, 'empty values removed');
  assert.deepEqual(missing, ['FAQPage']);
  assert.equal(schemaService.validate(schema, page).valid, true);
  assert.deepEqual(schemaService.applyPlan(generated, { types: [] }, page).schema['@graph'].length, 3, 'no plan keeps every typed node');
});

test('blocked public pages are read through the WordPress API; plans, export and backups work end to end', async t => {
  let origin; let plansSeen = [];
  const wp = express(); wp.use(express.json());
  wp.use('/wp-json', (req, res, next) => req.headers.authorization === `Basic ${Buffer.from('editor:password').toString('base64')}` ? next() : res.sendStatus(401));
  wp.get('/wp-json/wp/v2/types', (req, res) => res.json({ page: { rest_base: 'pages' } }));
  wp.get('/wp-json/wp/v2/pages', (req, res) => res.set('X-WP-TotalPages', '1').json([{ id: 5, link: `${origin}/ac-repair/`, type: 'page' }]));
  wp.get('/wp-json/wp/v2/pages/5', (req, res) => res.json({ id: 5, link: `${origin}/ac-repair/`, type: 'page', title: { rendered: 'AC Repair' }, content: { rendered: '<p>We repair air conditioners in Starkville.</p>' } }));
  wp.get('/wp-json/rankmath/v1/getHead', (req, res) => res.json({ success: true, head: `<title>AC Repair | Acme</title><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"${origin}/#organization"}]}</script>` }));
  wp.get('/ac-repair/', (req, res) => res.sendStatus(403));
  origin = await serve(wp, t);
  schemaService.generateAI = async (page, options, plan) => {
    plansSeen.push(plan);
    return { '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebPage', '@id': `${page.url}#webpage`, url: page.url },
      { '@type': 'Service', '@id': `${page.url}#service`, url: page.url, name: 'AC Repair', provider: { '@id': `${origin}/#organization` } }
    ] };
  };
  const app = express(); app.use(express.json()); app.use('/api', routes);
  const api = `${await serve(app, t)}/api`;
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(api + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const text = await response.text();
    try { const body = JSON.parse(text); if (!Array.isArray(body)) return { code: response.status, ...body }; } catch { /* Not JSON. */ }
    { return { code: response.status, text, disposition: response.headers.get('content-disposition') }; }
  };
  async function finished(id) {
    for (let i = 0; i < 200; i++) {
      const run = (await request(`/runs/${id}`)).run;
      if (!['discovering', 'crawling', 'generating', 'publishing'].includes(run.status)) return run;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('Run did not finish');
  }
  const site = (await request('/sites', 'POST', { name: 'Blocked', url: origin, connection: { username: 'editor', appPassword: 'password' } })).site;
  const id = (await request(`/sites/${site.id}/crawls`, 'POST', {})).run.id;
  let run = await finished(id);
  const page = run.pages[0];
  assert.equal(page.status, 'crawled', page.error);
  assert.equal(page.pageData.fetchedVia, 'wordpress-api');
  assert.equal(page.pageData.existingSchemaCount, 1, 'Rank Math head supplies existing schema');
  const detail = (await request(`/runs/${id}/page?url=${encodeURIComponent(page.url)}`)).page;
  assert.match(detail.pageData.content, /repair air conditioners/);

  const siteView = await request(`/sites/${site.id}?run=latest`);
  assert.equal(siteView.runs[0].pages, undefined, 'run history carries no page data');
  assert.equal(siteView.runs[0].pageCount, 1);
  assert.equal(siteView.run.id, id);
  assert.equal(siteView.run.pages.length, 1, 'the selected run comes back in full');
  assert.equal((await request(`/sites/${site.id}`)).run, undefined);
  const url = page.url;
  assert.equal((await request(`/runs/${id}/generate`, 'POST', { urls: [url], engine: 'ai', plans: { [url]: { types: ['Service'], notes: 'Starkville only' } } })).code, 202);
  run = await finished(id);
  assert.deepEqual(plansSeen.at(-1), { types: ['Service'], notes: 'Starkville only' });
  assert.deepEqual(run.pages[0].schema['@graph'].map(node => node['@type']), ['Service']);
  assert.deepEqual(run.pages[0].schemaPlan.types, ['Service']);
  assert.equal(run.pages[0].validation.valid, true, run.pages[0].validation.errors.join());

  const html = await request(`/runs/${id}/export?format=html`);
  assert.match(html.disposition, /schematic-127\.0\.0\.1.*\.html/);
  assert.match(html.text, /<!-- http:\/\/127\.0\.0\.1:\d+\/ac-repair\/ -->\n<script type="application\/ld\+json">/);
  const json = JSON.parse((await request(`/runs/${id}/export?format=json`)).text);
  assert.equal(json[0].schema['@graph'][0]['@type'], 'Service');

  const bundle = JSON.parse((await request(`/sites/${site.id}/backups`)).text);
  assert.deepEqual(bundle.map(item => item.kind).sort(), ['generated', 'original']);
  assert.ok(bundle.every(item => item.url === url));
});

test('a chosen type the AI leaves out gets one repair attempt, and a missing page URL is filled in', async () => {
  const page = { url: 'https://example.com/furnace-repair/', title: 'Furnace Repair', content: 'We repair furnaces.' };
  const calls = [];
  const original = schemaService.generateAI;
  schemaService.generateAI = async (input, options, plan, repair) => {
    calls.push(repair);
    const graph = [{ '@type': 'FAQPage', '@id': 'https://example.com/furnace-repair#faq', mainEntity: [{ '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: 'A.' } }] }];
    if (repair) graph.push({ '@type': 'Service', '@id': 'https://example.com/furnace-repair#service', name: 'Furnace Repair' });
    return { '@context': 'https://schema.org', '@graph': graph };
  };
  try {
    const { schema, missing } = await schemaService.generatePlanned(page, {}, { types: ['FAQPage', 'Service'] });
    assert.deepEqual(calls.map(call => call?.missing), [undefined, ['Service']]);
    assert.deepEqual(missing, []);
    assert.deepEqual(schema['@graph'].map(node => node['@type']), ['FAQPage', 'Service']);
    assert.equal(schemaService.validate(schema, page).valid, true);
  } finally { schemaService.generateAI = original; }
});
