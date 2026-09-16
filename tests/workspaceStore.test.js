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

  test('normalizes REST metadata mappings and defaults to the connector integration', () => {
    const defaulted = store.createSite({ name: 'Example', url: 'https://example.com' });
    assert.strictEqual(defaulted.mapping.integration, 'connector');
    assert.strictEqual(defaulted.mapping.restEncoding, 'json-string');

    const site = store.createSite({
      name: 'Shop', url: 'https://shop.example.com',
      mapping: { integration: 'rest-meta', restMetaKey: '_custom_schema_', restEncoding: 'object', restOverrides: { product: { key: 'product_jsonld', encoding: 'object' } } }
    });
    assert.strictEqual(site.mapping.integration, 'rest-meta');
    assert.strictEqual(site.mapping.restMetaKey, '_custom_schema_');
    assert.strictEqual(site.mapping.restEncoding, 'object');
    assert.deepStrictEqual(site.mapping.restOverrides, { product: { key: 'product_jsonld', encoding: 'object' } });
  });

  test('validates the optional default schema image', () => {
    const bare = store.createSite({ name: 'Example', url: 'https://example.com' });
    assert.strictEqual(bare.organization.image, '');

    const withImage = store.createSite({ name: 'Shop', url: 'https://shop.example.com', organization: { image: 'https://shop.example.com/brand.jpg' } });
    assert.strictEqual(withImage.organization.image, 'https://shop.example.com/brand.jpg');

    assert.throws(() => store.createSite({ name: 'Bad', url: 'https://bad.example.com', organization: { image: 'not-a-url' } }), /https:\/\/ URL/);
    assert.throws(() => store.createSite({ name: 'Bad', url: 'https://bad.example.com', organization: { image: 'http://insecure.example.com/x.jpg' } }), /https:\/\/ URL/);

    const updated = store.updateSite(withImage.id, { organization: { image: '' } });
    assert.strictEqual(updated.organization.image, '');
  });
});
