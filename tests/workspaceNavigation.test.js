const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const axios = require('axios');
const { once } = require('node:events');

test('all primary tabs render the same persistent workspace; legacy routes no longer exist', async t => {
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
    assert.match(html, /<aside class="sidebar">[\s\S]*id="site-list"[\s\S]*id="open-ai-settings"/);
    assert.match(html, /Only specific pages/);
    for (const step of ['crawl', 'choose', 'generate', 'review', 'publish']) assert.match(html, new RegExp(`data-step="${step}"`));
    assert.doesNotMatch(html, /id="schema-policy"|id="acknowledge-conflicts"|id="preview-publish"|Delete existing schema/, 'no policy, acknowledgement, preview or delete options');
  }
  for (const route of ['/legacy/generator', '/legacy/results']) {
    await assert.rejects(axios.get(base + route), error => error.response?.status === 404);
  }
});

test('wizard steps toggle panels, mark progress, and preserve site/run context in the URL without reloading', () => {
  const nodes = new Map();
  const element = () => ({
    hidden: false, textContent: '', value: '', checked: false, disabled: false, className: '',
    attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; },
    selectedOptions: [{ textContent: '' }], addEventListener() {},
    classList: { toggle() {}, add() {}, remove() {} }, style: { setProperty() {} }
  });
  const withClassList = node => {
    const classes = new Set();
    return { ...node, classes, classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); }, add() {}, remove() {} } };
  };
  const wizardPanels = ['crawl', 'choose', 'generate', 'review', 'publish'].map(step => ({ ...element(), dataset: { wizardStep: step } }));
  const wizardButtons = ['crawl', 'choose', 'generate', 'review', 'publish'].map(step => withClassList({ ...element(), dataset: { step } }));
  let location = new URL('http://localhost:3000/');
  const session = new Map();
  const context = vm.createContext({
    URL, URLSearchParams,
    window: { get location() { return location; }, history: {
      replaceState(a, b, url) { location = new URL(url); },
      pushState(a, b, url) { location = new URL(url); }
    } },
    sessionStorage: { getItem: key => session.get(key), setItem: (key, value) => session.set(key, value) },
    document: {
      addEventListener() {},
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
      querySelectorAll(selector) {
        if (selector === '[data-wizard-step]') return wizardPanels;
        if (selector === '.wizard-step') return wizardButtons;
        return [];
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/workspace.js'), 'utf8'), context);
  vm.runInContext("state.activeSite = { id: 'site-a', name: 'Alpha' }; state.activeRun = { id: 'run-a', pages: [{url:'https://a.test/page', pageData: {}}] }; syncNavigation(); setWizardStep('choose');", context);
  assert.equal(location.searchParams.get('site'), 'site-a');
  assert.equal(location.searchParams.get('run'), 'run-a');
  assert.equal(wizardPanels[1].hidden, false); assert.equal(wizardPanels[0].hidden, true);
  assert.ok(wizardButtons[1].classes.has('active'));
  assert.ok(wizardButtons[0].classes.has('done'), 'crawl is done once pages were read');
  assert.equal(wizardButtons[1].attributes['aria-current'], 'step');
  vm.runInContext("setWizardStep('publish');", context);
  assert.equal(wizardPanels[4].hidden, false); assert.equal(wizardPanels[1].hidden, true);
  assert.ok(wizardButtons[2].classes.has('reachable'), 'every step can be opened');
  vm.runInContext("state.activeRun.pages[0].schema = {}; resetWizard();", context);
  assert.equal(vm.runInContext('state.wizardStep', context), 'review', 'a run with schema opens on Review');
  assert.equal(vm.runInContext('state.activeRun.pages.length', context), 1);
  assert.deepEqual(JSON.parse(session.get('schematic-context')), { site: 'site-a', run: 'run-a' });
});
