const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-workspace-'));
process.env.DATA_DIR = testDataDir;
process.env.APP_SECRET = 'workspace-store-test-secret';
const store = require('../src/services/workspaceStore');

beforeEach(() => {
  for (const name of fs.readdirSync(testDataDir)) {
    fs.rmSync(path.join(testDataDir, name), { recursive: true, force: true });
  }
});

describe('Workspace Store', () => {
  test('persists sites without exposing credentials', () => {
    const site = store.createSite({
      name: 'Example', url: 'https://example.com/',
      connection: { type: 'application-password', username: 'editor', appPassword: 'abcd efgh' }
    });

    assert.strictEqual(site.url, 'https://example.com');
    assert.strictEqual(site.connection.hasAppPassword, true);
    assert.strictEqual(site.connection.appPassword, undefined);

    const storedText = fs.readFileSync(path.join(testDataDir, 'workspace.json'), 'utf8');
    assert.strictEqual(storedText.includes('abcd efgh'), false);
    assert.strictEqual(store.getSite(site.id, true).connection.appPassword, 'abcd efgh');
  });

  test('keeps run history and removes it with its site', () => {
    const site = store.createSite({ name: 'Example', url: 'https://example.com' });
    const run = store.createRun(site.id, { sitemapUrl: 'https://example.com/sitemap.xml' });
    store.updateRun(run.id, { status: 'ready', pages: [{ url: 'https://example.com/page', status: 'discovered' }] });

    assert.strictEqual(store.listRuns(site.id).length, 1);
    assert.strictEqual(store.getRun(run.id).status, 'ready');
    assert.strictEqual(store.deleteSite(site.id), true);
    assert.strictEqual(store.getRun(run.id), null);
  });

  test('normalizes customizable metadata mappings', () => {
    const site = store.createSite({
      name: 'Shop', url: 'https://shop.example.com',
      mapping: { postTypes: ['products'], schemaMetaPrefix: '_custom_schema_', richSnippetKey: '_snippet' }
    });
    assert.deepStrictEqual(site.mapping.postTypes, ['products']);
    assert.strictEqual(site.mapping.schemaMetaPrefix, '_custom_schema_');
    assert.strictEqual(site.mapping.richSnippetKey, '_snippet');
    assert.strictEqual(site.mapping.fallbackToContent, false);
  });
});
