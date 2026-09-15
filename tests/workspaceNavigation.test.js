const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const axios = require('axios');
const { once } = require('node:events');

test('all primary tabs render the same persistent workspace; legacy tools remain separate', async t => {
  const app = express(); app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../src/views'));
  app.use(require('../src/routes/index'));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/', '/generator', '/results']) {
    const response = await axios.get(base + route + '?site=site-a&run=run-a');
    assert.equal(response.status, 200);
    const html = response.data;
    for (const id of ['site-list', 'generate-run', 'publish-run', 'run-history']) assert.ok(html.includes(`id="${id}"`));
    assert.match(html, /\/js\/workspace.js/);
    assert.doesNotMatch(html, /src="\/js\/app.js"/);
    assert.doesNotMatch(html, />Advanced Generator</);
    assert.doesNotMatch(html, /1\. Crawl\. 2\. Create schema|Connect each WordPress site once/);
    assert.match(html, /class="workspace-toolbar"/);
    assert.match(html, /Choose a sitemap or specific URLs/);
  }
  for (const route of ['/legacy/generator', '/legacy/results']) {
    const response = await axios.get(base + route);
    assert.equal(response.status, 200);
    assert.match(response.data, /Legacy/);
  }
});

test('tab navigation preserves site, run and page selection without reloading', () => {
  const nodes = new Map();
  const element = () => ({ hidden: false, textContent: '', attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; } });
  const links = ['sites', 'generate', 'results'].map(section => ({ ...element(), dataset: { workspaceSection: section } }));
  const panels = ['sites', 'generate', 'results'].map(section => ({ ...element(), dataset: { workspacePanel: section } }));
  let location = new URL('http://localhost:3000/');
  const history = [];
  const session = new Map();
  const context = vm.createContext({
    URL, URLSearchParams,
    window: { get location() { return location; }, history: {
      replaceState(a, b, url) { location = new URL(url); },
      pushState(a, b, url) { history.push(String(url)); location = new URL(url); }
    } },
    sessionStorage: { getItem: key => session.get(key), setItem: (key, value) => session.set(key, value) },
    document: {
      addEventListener() {},
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
      querySelectorAll(selector) { return selector === '[data-workspace-section]' ? links : panels; }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/workspace.js'), 'utf8'), context);
  vm.runInContext("state.activeSite = { id: 'site-a', name: 'Alpha' }; state.activeRun = { id: 'run-a', pages: [{url:'https://a.test/page'}] }; syncNavigation(); navigateWorkflow('generate');", context);
  assert.equal(location.pathname, '/generator');
  assert.equal(location.searchParams.get('site'), 'site-a');
  assert.equal(location.searchParams.get('run'), 'run-a');
  assert.equal(panels[1].hidden, false); assert.equal(panels[0].hidden, true);
  assert.equal(links[1].attributes['aria-current'], 'page');
  vm.runInContext("navigateWorkflow('results');", context);
  assert.equal(location.pathname, '/results');
  assert.equal(links[2].href, '/results?site=site-a&run=run-a');
  assert.equal(vm.runInContext('state.activeRun.pages.length', context), 1);
  assert.equal(history.length, 2);
  assert.deepEqual(JSON.parse(session.get('schema-workspace-context')), { site: 'site-a', run: 'run-a' });
});
