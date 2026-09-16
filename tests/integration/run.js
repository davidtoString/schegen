// Run only against the two disposable installations declared in this directory.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'schegen-real-wp-'));
process.env.APP_SECRET = 'isolated-test-only';
process.env.OPENAI_API_KEY = 'fixture-only-not-a-real-key';
const express = require('express');
const connector = require('../../src/services/wordpressConnector');
const store = require('../../src/services/workspaceStore');
const schemas = require('../../src/services/pageSchema');
// Exercise the mandatory AI route without charging an external provider; live AI needs staging testing.
schemas.generateAI = async page => schemas.generate(page);
const app = express(); app.use(express.json()); app.use('/api', require('../../src/routes/workspaces'));
const compose = path.join(__dirname, 'compose.yaml');
function initialize(service, mode) {
  return execFileSync('docker', ['compose', '-f', compose, 'exec', '-T', '--user', 'www-data', service, 'php', '/fixture/initialize.php', ...(mode ? [mode] : [])], { encoding: 'utf8', timeout: 60000 });
}
async function main() {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const api = `http://127.0.0.1:${server.address().port}/api`;
  async function request(url, body) {
    const response = await fetch(api + url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  }
  async function finished(id) {
    for (let i = 0; i < 200; i++) {
      const run = (await request(`/runs/${id}`)).run;
      if (!['discovering', 'crawling', 'generating', 'publishing'].includes(run.status)) return run;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Workflow timed out');
  }
  try {
    for (const [service, prefix] of [['wp-a', 'alpha_'], ['wp-b', 'client_b_42_']]) {
      const setup = JSON.parse(initialize(service));
      assert.equal(setup.prefix, prefix);
      for (const mode of ['connector', 'rankmath']) {
        initialize(service, 'connector');
        if (mode === 'rankmath') initialize(service, 'rankmath');
        const site = (await request('/sites', {
          name: `${service}-${mode}`, url: setup.url,
          connection: { username: setup.username, appPassword: setup.appPassword }
        })).site;
        const connection = await request(`/sites/${site.id}/test`, {});
        assert.equal(connection.success, true);
        if (mode === 'rankmath') assert.equal(connection.result.rankMath, true);
        const discovered = await connector.create(store.getSite(site.id, true)).discover(100);
        assert.ok(discovered.some(p => p.postType === 'fixture_item'));
        assert.ok(discovered.some(p => p.url === setup.urls[0]), 'static front page discovered');
        const id = (await request(`/sites/${site.id}/crawls`, { urls: setup.urls })).run.id;
        let run = await finished(id);
        assert.equal(run.summary.crawled, 2, JSON.stringify(run.pages.map(p => p.error)));
        await request(`/runs/${id}/generate`, { urls: setup.urls });
        run = await finished(id); assert.equal(run.summary.generated, 2);
        const preview = await request(`/runs/${id}/publish`, { urls: setup.urls, schemaPolicy: 'review' });
        assert.equal(preview.success, true, JSON.stringify(preview));
        const inserted = await request(`/runs/${id}/publish`, { urls: setup.urls, dryRun: false, schemaPolicy: 'review', acknowledgeConflicts: true });
        assert.equal(inserted.success, true, JSON.stringify(inserted));
        assert.ok(inserted.results.every(p => p.stored && p.verified), JSON.stringify(inserted));
        run = await finished(id); assert.equal(run.summary.published, 2);
        assert.ok(run.pages.every(p => p.previousState && p.insertionHistory.length >= 2));
        const restored = await request(`/runs/${id}/rollback`, { urls: setup.urls });
        assert.equal(restored.success, true, JSON.stringify(restored));
        if (mode === 'rankmath') {
          const client = connector.create(store.getSite(site.id, true));
          for (const schemaPolicy of ['replace-existing', 'remove-existing']) {
            const preview = await request(`/runs/${id}/publish`, { urls: setup.urls, schemaPolicy });
            assert.equal(preview.success, true, JSON.stringify(preview));
            const applied = await request(`/runs/${id}/publish`, { urls: setup.urls, schemaPolicy, acknowledgeConflicts: true, dryRun: false });
            assert.ok(applied.success && applied.results.every(result => result.verified), JSON.stringify(applied));
            for (const url of setup.urls) {
              const live = await client.inspectPublic(url);
              if (schemaPolicy === 'remove-existing') assert.equal(live.length, 0, 'Rank Math graph removed from public page');
              else assert.equal(live.flatMap(graph => graph['@graph'] || []).length, 1, 'AI fixture replaces rather than duplicates Rank Math nodes');
            }
            const undo = await request(`/runs/${id}/rollback`, { urls: setup.urls });
            assert.equal(undo.success, true, JSON.stringify(undo));
            assert.ok((await client.inspectPublic(setup.urls[0])).length > 0, 'Rank Math output restored');
          }
        }
        console.log(`PASS WordPress ${setup.version} | ${prefix} | ${mode} | front page + custom type + rollback`);
      }
    }
    console.log('All six real WordPress workflows passed. No production sites contacted.');
  } finally { server.closeAllConnections(); server.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
