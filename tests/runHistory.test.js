const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { once } = require('node:events');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'schematic-history-'));
process.env.APP_SECRET = 'test-only';
const store = require('../src/services/workspaceStore');
const routes = require('../src/routes/workspaces');

test('runs can be deleted one at a time or in bulk, never while running or across sites', async t => {
  const app = express(); app.use(express.json()); app.use('/api', routes);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const api = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (url, body) => { const response = await fetch(api + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { code: response.status, ...(await response.json()) }; };
  const site = store.createSite({ name: 'A', url: 'https://a.example' });
  const other = store.createSite({ name: 'B', url: 'https://b.example' });
  const [r1, r2, r3, r4] = [1, 2, 3, 4].map(() => store.createRun(site.id));
  const foreign = store.createRun(other.id);
  for (const run of [r2, r3, r4, foreign]) store.updateRun(run.id, { status: 'ready' });
  store.updateRun(r1.id, { status: 'completed', pages: [{ url: 'https://a.example/x', writeReceipt: { rolledBack: false } }] });
  assert.equal(store.listRunSummaries(site.id).find(run => run.id === r1.id).undoable, 1, 'summary says how many publishes depend on the run');

  const one = await call(`/sites/${site.id}/runs/delete`, { ids: [r1.id] });
  assert.equal(one.deleted, 1);
  assert.deepEqual(one.runs.map(run => run.id).sort(), [r2.id, r3.id, r4.id].sort());

  const bulk = await call(`/sites/${site.id}/runs/delete`, { ids: [r2.id, r3.id] });
  assert.equal(bulk.deleted, 2);

  store.updateRun(r4.id, { status: 'generating' });
  assert.equal((await call(`/sites/${site.id}/runs/delete`, { ids: [r4.id] })).code, 409, 'a running run is kept');
  assert.equal((await call(`/sites/${site.id}/runs/delete`, { ids: [foreign.id] })).code, 404, 'another site\'s run cannot be deleted here');
  assert.equal((await call(`/sites/${site.id}/runs/delete`, { ids: [] })).code, 400);
  assert.ok(store.getRun(foreign.id) && store.getRun(r4.id));
});
