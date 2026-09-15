const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { once } = require('node:events');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-workflow-'));
process.env.APP_SECRET = 'test-only';
process.env.OPENAI_API_KEY = 'fixture-only-not-a-real-key';
const store = require('../src/services/workspaceStore');
const schemaService = require('../src/services/pageSchema');
schemaService.generateAI = async page => schemaService.generate(page);
const connector = require('../src/services/wordpressConnector');
const routes = require('../src/routes/workspaces');

test('generic pages do not invent HVAC services; malformed and noindex graphs fail validation', () => {
  const page = { url: 'https://example.com/about', title: 'About us', content: 'An independent publisher.' };
  const graph = schemaService.generate(page);
  assert.equal(graph['@graph'][0]['@type'], 'AboutPage');
  assert.doesNotMatch(JSON.stringify(graph), /HVAC|Offer|rating|address/);
  assert.equal(schemaService.validate(graph, page).valid, true);
  assert.equal(schemaService.validate({ '@graph': {} }, page).valid, false);
  assert.equal(schemaService.validate(graph, { ...page, robots: 'noindex, follow' }).valid, false);
});

test('crawl → schema → dry run → insert → public verification with a WordPress contract fixture', async t => {
  let origin; let saved = null; let visible = true; let rejectWrite = false; let writes = 0;
  const wp = express(); wp.use(express.json());
  wp.use('/wp-json', (req, res, next) => req.headers.authorization === `Basic ${Buffer.from('editor:password').toString('base64')}` ? next() : res.sendStatus(401));
  wp.get('/wp-json/wp/v2/types', (req, res) => res.json({ page: { rest_base: 'pages' } }));
  wp.get('/wp-json/wp/v2/pages', (req, res) => res.set('X-WP-TotalPages', '1').json([{ id: 17, link: `${origin}/parent/about`, type: 'page' }]));
  wp.get('/wp-json/schema-workspace/v1/status', (req, res) => res.json({ success: true, user: 'Editor' }));
  wp.get('/wp-json/schema-workspace/v1/schema', (req, res) => res.json({ postId: 17, schema: saved }));
  wp.post('/wp-json/schema-workspace/v1/schema', (req, res) => {
    assert.ok(Object.hasOwn(req.body, 'expected'));
    assert.equal(store.listRuns()[0].pages[0].previousState.postId, 17, 'backup persisted before write');
    if (rejectWrite) return res.status(403).json({ message: 'Write forbidden' });
    saved = req.body.schema; writes++; res.json({ success: true });
  });
  wp.post('/wp-json/schema-workspace/v1/restore', (req, res) => {
    if (JSON.stringify(req.body.expected) !== JSON.stringify(saved)) return res.sendStatus(409);
    saved = req.body.schema; res.json({ postId: 17, schema: saved });
  });
  wp.get('/parent/about', (req, res) => {
    assert.equal(req.headers.authorization, undefined, 'public crawl does not leak credentials');
    res.send(`<html lang="en"><head><title>About our publishing company</title></head><body class="page"><main><h1>About our publishing company</h1><p>We publish books about local history and culture.</p></main>${saved && visible ? `<script id="schema-workspace-jsonld" type="application/ld+json">${JSON.stringify(saved)}</script>` : ''}</body></html>`);
  });
  const wpServer = wp.listen(0, '127.0.0.1'); await once(wpServer, 'listening');
  origin = `http://127.0.0.1:${wpServer.address().port}`;
  const app = express(); app.use(express.json()); app.use('/api', routes);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); wpServer.closeAllConnections(); wpServer.close(); });
  const api = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(api + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { code: response.status, ...(await response.json()) };
  };
  const site = (await request('/sites', 'POST', { name: 'Fixture', url: origin, connection: { username: 'editor', appPassword: 'password' } })).site;
  assert.equal((await request(`/sites/${site.id}/test`, 'POST', {})).success, true);
  const crawl = await request(`/sites/${site.id}/crawls`, 'POST', {});
  assert.equal(crawl.code, 202);
  const id = crawl.run.id;
  async function finished() {
    for (let i = 0; i < 150; i++) {
      const run = (await request(`/runs/${id}`)).run;
      if (!['discovering', 'crawling', 'generating', 'publishing'].includes(run.status)) return run;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Run did not finish');
  }
  let run = await finished();
  assert.equal(run.pages[0].status, 'crawled');
  assert.match(run.pages[0].pageData.content, /publish books/);
  const urls = run.pages.map(p => p.url);
  assert.equal((await request(`/runs/${id}/generate`, 'POST', { urls })).code, 202);
  run = await finished(); assert.equal(run.pages[0].validation.valid, true);
  assert.equal((await request(`/runs/${id}/publish`, 'POST', { urls: [] })).code, 400);
  assert.equal((await request(`/runs/${id}/publish`, 'POST', { urls, dryRun: false })).success, false, 'real insertion requires preview');
  assert.equal((await request(`/runs/${id}/publish`, 'POST', { urls })).success, true);
  assert.equal(writes, 0, 'preview must not insert');
  let result = await request(`/runs/${id}/publish`, 'POST', { urls, dryRun: false });
  assert.equal(result.results[0].verified, true); assert.equal(writes, 1);
  assert.equal((await request(`/runs/${id}/rollback`, 'POST', { urls })).success, true);
  assert.equal(saved, null, 'rollback removes first app insertion');
  assert.equal((await request(`/runs/${id}/rollback`, 'POST', { urls })).code, 400);
  await request(`/runs/${id}/publish`, 'POST', { urls, schemaPolicy: 'replace-managed' });
  assert.equal((await request(`/runs/${id}/publish`, 'POST', { urls, schemaPolicy: 'replace-managed', dryRun: false })).success, true);
  const beforeKeep = writes;
  await request(`/runs/${id}/publish`, 'POST', { urls });
  assert.equal((await request(`/runs/${id}/publish`, 'POST', { urls, dryRun: false })).results[0].skipped, true);
  assert.equal(writes, beforeKeep, 'keep existing does not write');
  visible = false;
  await request(`/runs/${id}/publish`, 'POST', { urls, schemaPolicy: 'replace-managed' });
  result = await request(`/runs/${id}/publish`, 'POST', { urls, schemaPolicy: 'replace-managed', dryRun: false });
  assert.equal(result.results[0].stored, true); assert.equal(result.results[0].verified, false);
  assert.equal((await request(`/runs/${id}`)).run.pages[0].status, 'verification_pending');
  visible = true;
  assert.equal((await request(`/runs/${id}/verify`, 'POST', { urls })).run.pages[0].status, 'published');
  rejectWrite = true;
  await request(`/runs/${id}/publish`, 'POST', { urls, schemaPolicy: 'replace-managed' });
  assert.equal((await request(`/runs/${id}/publish`, 'POST', { urls, schemaPolicy: 'replace-managed', dryRun: false })).success, false);
  run = (await request(`/runs/${id}`)).run;
  assert.equal(run.pages[0].status, 'publish_failed'); assert.ok(run.pages[0].publishError);
  saved = { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage', name: 'External change' }] };
  const rollback = await request(`/runs/${id}/rollback`, 'POST', { urls });
  assert.equal(rollback.success, false);
  assert.match(rollback.results[0].error, /changed after/);
  const client = connector.create({ url: origin, connection: { username: 'editor', appPassword: 'password' } });
  await assert.rejects(client.snapshot('https://other.example/page'), /registered site/);
});
