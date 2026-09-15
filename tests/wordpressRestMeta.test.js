const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { create } = require('../src/services/wordpressConnector');

for (const encoding of ['json-string', 'object']) {
  test(`direct REST: ${encoding}, custom namespace, exact URLs, read-back and public output`, async t => {
    let origin, value = encoding === 'object' ? {} : '', writes = 0;
    let visible = true, readonly = false, ignore = false, forbidden = false;
    const key = encoding === 'object' ? '_custom_product_graph' : 'editorial_jsonld';
    const wp = express(); wp.use(express.json());
    wp.use('/blog/wp-json', (req, res, next) => {
      assert.equal(req.headers.authorization, `Basic ${Buffer.from('editor:password').toString('base64')}`);
      next();
    });
    wp.get('/blog/wp-json/wp/v2/users/me', (req, res) => res.json({ id: 8, name: 'Editor' }));
    wp.get('/blog/wp-json/wp/v2/types', (req, res) => res.json({ wp_global_styles: { rest_base: 'global-styles' }, nav_menu_item: { rest_base: 'menu-items' }, product: { rest_namespace: 'catalog/v3', rest_base: 'items' } }));
    wp.get('/blog/wp-json/catalog/v3/items', (req, res) => res.set('X-WP-TotalPages', '2').json([
      { id: Number(req.query.page) === 1 ? 9 : 17, link: `${origin}/blog/${Number(req.query.page) === 1 ? 'other' : 'parent'}/about`, type: 'product' }
    ]));
    wp.options('/blog/wp-json/catalog/v3/items/17', (req, res) => res.json({ schema: { properties: { meta: { properties: { [key]: { type: encoding === 'object' ? 'object' : 'string', readonly } } } } } }));
    wp.get('/blog/wp-json/catalog/v3/items/17', (req, res) => {
      assert.equal(req.query.context, 'edit');
      res.json({ id: 17, link: `${origin}/blog/parent/about`, status: 'publish', password: '', meta: { [key]: value, unrelated: 'preserve' } });
    });
    wp.post('/blog/wp-json/catalog/v3/items/17', (req, res) => {
      if (forbidden) return res.status(403).json({ message: 'Not allowed' });
      assert.deepEqual(Object.keys(req.body), ['meta']);
      assert.deepEqual(Object.keys(req.body.meta), [key]);
      writes++; if (!ignore) value = req.body.meta[key];
      res.json({ id: 17 });
    });
    wp.get('/blog/parent/about', (req, res) => {
      assert.equal(req.headers.authorization, undefined);
      res.send(visible ? `<script type="application/ld+json">${encoding === 'object' ? JSON.stringify(value) : value}</script>` : '<p>No schema renderer</p>');
    });
    const server = wp.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    origin = `http://127.0.0.1:${server.address().port}`;
    const site = { url: `${origin}/blog`, connection: { username: 'editor', appPassword: 'password' }, mapping: { integration: 'rest-meta', restMetaKey: 'different_default', restOverrides: { product: { key, encoding } } } };
    const client = create(site), url = `${origin}/blog/parent/about`;
    assert.equal((await client.testConnection()).integration, 'rest-meta');
    const previous = await client.snapshot(url);
    assert.equal(previous.postId, 17); assert.equal(previous.metaKey, key); assert.equal(writes, 0);
    const schema = { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage', '@id': `${url}#schema`, url, name: 'Quoted "title" & text' }] };
    assert.equal((await client.insert(url, schema, previous)).verified, true);
    assert.equal(writes, 1);
    visible = false;
    assert.equal((await client.verify(url, schema)).verified, false);
    readonly = true;
    await assert.rejects(client.snapshot(url), /not exposed as writable/);
    readonly = false;
    const stale = await client.snapshot(url);
    value = encoding === 'object' ? { changed: true } : 'changed';
    await assert.rejects(client.insert(url, schema, stale), /changed since preview/);
    assert.equal(writes, 1);
    ignore = true;
    await assert.rejects(client.insert(url, schema, await client.snapshot(url)), /read-back differs/);
    forbidden = true;
    await assert.rejects(client.insert(url, schema, await client.snapshot(url)), /403/);
    await assert.rejects(client.snapshot(`${origin}/blog/missing/about`), /exactly one/);
    await assert.rejects(client.snapshot('https://other.example/about'), /registered site/);
    const missing = create({ ...site, mapping: { integration: 'rest-meta', restMetaKey: 'not_registered' } });
    await assert.rejects(missing.snapshot(url), /not exposed as writable/);
  });
}
