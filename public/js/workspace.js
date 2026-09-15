const state = { sites: [], activeSite: null, activeRun: null, poller: null };

const $ = id => document.getElementById(id);
const workflowPaths = { sites: '/', generate: '/generator', results: '/results' };
function currentSection() { return Object.keys(workflowPaths).find(key => workflowPaths[key] === window.location.pathname) || 'sites'; }
function savedContext() { try { return JSON.parse(sessionStorage.getItem('schema-workspace-context') || '{}'); } catch { return {}; } }
function syncNavigation(replace = true) {
  const url = new URL(window.location.href);
  if (state.activeSite) url.searchParams.set('site', state.activeSite.id); else url.searchParams.delete('site');
  if (state.activeRun) url.searchParams.set('run', state.activeRun.id); else url.searchParams.delete('run');
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
  try { sessionStorage.setItem('schema-workspace-context', JSON.stringify({ site: state.activeSite?.id, run: state.activeRun?.id })); } catch { /* URL still preserves context. */ }
  const section = currentSection();
  document.querySelectorAll('[data-workspace-section]').forEach(link => {
    const destination = new URL(workflowPaths[link.dataset.workspaceSection], url);
    destination.search = url.search;
    link.href = destination.pathname + destination.search;
    if (link.dataset.workspaceSection === section) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-workspace-panel]').forEach(panel => { panel.hidden = panel.dataset.workspacePanel !== section; });
  const labels = { sites: 'Sites & Crawl', generate: 'Generate', results: 'Results & Publish' };
  $('workflow-location').textContent = labels[section];
  $('workflow-back').hidden = section === 'sites';
  $('workflow-next').hidden = section === 'results';
  $('workflow-next').textContent = section === 'sites' ? 'Continue to Generate →' : 'Continue to Results & Publish →';
  $('workflow-next').disabled = !state.activeRun || !(section === 'sites' ? state.activeRun.pages.some(page => page.pageData) : state.activeRun.pages.some(page => page.validation?.valid));
}
function navigateWorkflow(section) {
  const url = new URL(window.location.href); url.pathname = workflowPaths[section];
  window.history.pushState({}, '', url);
  syncNavigation();
  $('workflow-guide').textContent = section === 'generate' ? 'Select pages below, choose your AI model, then Generate AI schema → Review.' : section === 'results' ? 'Preview your replace/remove action, review each page, approve, then apply. Undo remains available.' : 'Connect your site and click Crawl site to begin.';
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  $('open-ai-settings').addEventListener('click', openAISettings);
  $('close-ai-settings').addEventListener('click', () => $('ai-settings-dialog').close());
  $('ai-settings-dialog').addEventListener('close', () => {
    for (const provider of ['openai', 'gemini']) $(`settings-${provider}-key`).value = '';
  });
  $('ai-settings-form').addEventListener('submit', saveAISettings);
  $('ai-provider').addEventListener('change', applyAIProvider);
  loadAISettings().catch(error => notify(error.message, 'error'));
  document.querySelectorAll('[data-workspace-section]').forEach(link => link.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault(); navigateWorkflow(link.dataset.workspaceSection);
  }));
  $('workflow-next').addEventListener('click', () => navigateWorkflow(currentSection() === 'sites' ? 'generate' : 'results'));
  $('workflow-back').addEventListener('click', () => navigateWorkflow(currentSection() === 'results' ? 'generate' : 'sites'));
  window.addEventListener('popstate', async () => {
    const query = new URLSearchParams(window.location.search);
    try {
      const siteId = query.get('site');
      if (siteId && (siteId !== state.activeSite?.id || query.get('run') !== state.activeRun?.id)) await selectSite(siteId, query.get('run'));
      else syncNavigation();
    } catch (error) { notify(error.message, 'error'); }
  });
  $('add-site').addEventListener('click', openNewSite);
  document.querySelector('[data-action="new-site"]').addEventListener('click', openNewSite);
  $('close-dialog').addEventListener('click', closeDialog);
  $('cancel-dialog').addEventListener('click', closeDialog);
  $('site-form').addEventListener('submit', saveSite);
  $('delete-site').addEventListener('click', deleteSite);
  $('connection-type').addEventListener('change', toggleConnectionFields);
  $('integration').addEventListener('change', toggleConnectionFields);
  $('test-site').addEventListener('click', testSite);
  $('edit-site').addEventListener('click', editSite);
  $('start-crawl').addEventListener('click', discoverPages);
  $('generate-run').addEventListener('click', generateRun);
  $('preview-publish').addEventListener('click', () => publishRun(true));
  $('publish-run').addEventListener('click', () => publishRun(false));
  $('schema-policy').addEventListener('change', () => { $('acknowledge-conflicts').checked = false; renderRun(); });
  $('acknowledge-conflicts').addEventListener('change', updatePublishControls);
  $('rollback-run').addEventListener('click', async () => {
    const urls = selectedUrls();
      if (!urls.length) return notify('Select pages with an app change to undo.', 'error');
      if (!window.confirm(`Undo the last app change for ${urls.length} page(s), restoring previous schema and Rank Math output? Rank Math settings and other metadata will not change.`)) return;
    try {
      const body = await api(`/api/workspaces/runs/${state.activeRun.id}/rollback`, { method: 'POST', body: JSON.stringify({ urls }) });
      state.activeRun = body.run; renderRun(); await refreshHistory();
      notify(`Restored: ${body.results.filter(result => result.restored).length}/${body.results.length}. Review each page's result.`, body.success ? 'success' : 'error');
    } catch (error) { notify(error.message, 'error'); }
  });
  $('close-schema').addEventListener('click', () => $('schema-dialog').close());
  $('verify-run').addEventListener('click', async () => {
    try {
      const body = await api(`/api/workspaces/runs/${state.activeRun.id}/verify`, { method: 'POST', body: JSON.stringify({ urls: selectedUrls() }) });
      state.activeRun = body.run; renderRun();
    } catch (error) { notify(error.message, 'error'); }
  });
  loadSites();
});

let configuredAI;
let modelDrafts = {};
let generationProvider;
async function loadAISettings() {
  const body = await api('/api/workspaces/settings/ai');
  configuredAI = body.settings;
  $('ai-provider').value = configuredAI.defaultProvider;
  applyAIProvider();
}
function applyAIProvider() {
  if (generationProvider) modelDrafts[generationProvider] = $('ai-model').value;
  const provider = $('ai-provider').value;
  const settings = configuredAI?.providers[provider];
  generationProvider = provider;
  setupModelPicker('ai-model', settings?.models || [], modelDrafts[provider] ?? settings?.model ?? '', `Use saved default (${settings?.model || settings?.defaultModel || 'provider default'})`);
  $('ai-configuration-status').textContent = settings?.hasSavedKey ? 'Using encrypted key saved in AI Settings.' : settings?.hasEnvironmentKey ? 'Using server environment key.' : 'No saved key. Open AI Settings to configure this provider.';
}
async function openAISettings() {
  try {
    const body = await api('/api/workspaces/settings/ai'); configuredAI = body.settings;
    $('settings-provider').value = configuredAI.defaultProvider;
    for (const provider of ['openai', 'gemini']) {
      const settings = configuredAI.providers[provider];
      $(`settings-${provider}-key`).value = '';
      setupModelPicker(`settings-${provider}-model`, settings.models || [], settings.model, `App default (${settings.defaultModel})`);
      $(`settings-${provider}-remove`).checked = false;
      $(`settings-${provider}-status`).textContent = `${settings.hasSavedKey ? 'Encrypted key saved' : 'No key saved in UI'}${settings.hasEnvironmentKey ? ' · Environment key also configured' : ''}. Key validity is checked when you generate.`;
    }
    $('ai-settings-message').textContent = '';
    $('ai-settings-dialog').showModal();
  } catch (error) { notify(error.message, 'error'); }
}
async function saveAISettings(event) {
  event.preventDefault();
  const button = $('save-ai-settings'); button.disabled = true;
  try {
    const providers = Object.fromEntries(['openai', 'gemini'].map(provider => [provider, {
      apiKey: $(`settings-${provider}-key`).value.trim(), model: selectedModel(`settings-${provider}-model`), removeKey: $(`settings-${provider}-remove`).checked
    }]));
    const body = await api('/api/workspaces/settings/ai', { method: 'PUT', body: JSON.stringify({ defaultProvider: $('settings-provider').value, providers }) });
    configuredAI = body.settings; modelDrafts = {}; generationProvider = undefined; $('ai-provider').value = configuredAI.defaultProvider; applyAIProvider();
    $('ai-settings-dialog').close(); notify('AI settings saved. No restart needed.', 'success');
  } catch (error) { $('ai-settings-message').textContent = error.message; }
  finally { button.disabled = false; }
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function notify(message, kind = 'info') {
  const alert = $('workspace-alert');
  alert.textContent = message;
  alert.className = `workspace-alert ${kind}`;
  alert.hidden = false;
  window.clearTimeout(alert._timer);
  alert._timer = window.setTimeout(() => { alert.hidden = true; }, 6000);
}

async function loadSites(preferredId) {
  try {
    const body = await api('/api/workspaces/sites');
    state.sites = body.sites;
    renderSites();
    const query = new URLSearchParams(window.location.search);
    const context = savedContext();
    const candidate = preferredId || query.get('site') || state.activeSite?.id || context.site;
    const id = state.sites.some(site => site.id === candidate) ? candidate : state.sites[0]?.id;
    if (state.sites.length) await selectSite(id, query.get('run') || context.run);
    else showEmpty();
  } catch (error) { notify(error.message, 'error'); }
}

function renderSites() {
  $('site-count').textContent = state.sites.length;
  const list = $('site-list');
  list.replaceChildren();
  if (!state.sites.length) {
    const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No sites registered yet.'; list.append(p); return;
  }
  state.sites.forEach(site => {
    const button = document.createElement('button');
    button.className = `site-item${state.activeSite?.id === site.id ? ' active' : ''}`;
    const icon = document.createElement('span'); icon.className = 'site-avatar'; icon.textContent = site.name.slice(0, 2).toUpperCase();
    const text = document.createElement('span');
    const strong = document.createElement('strong'); strong.textContent = site.name;
    const small = document.createElement('small'); small.textContent = new URL(site.url).hostname;
    text.append(strong, small); button.append(icon, text);
    button.addEventListener('click', () => selectSite(site.id)); list.append(button);
  });
}

function showEmpty() {
  state.activeSite = null; state.activeRun = null;
  syncNavigation();
  $('empty-state').hidden = false;
  $('site-panel').hidden = true;
}

async function selectSite(id, preferredRun) {
  window.clearInterval(state.poller);
  const selection = state.selection = (state.selection || 0) + 1;
  const body = await api(`/api/workspaces/sites/${id}`);
  let chosenRun = body.runs.find(run => run.id === preferredRun);
  if (preferredRun && !chosenRun) {
    try { const saved = await api(`/api/workspaces/runs/${encodeURIComponent(preferredRun)}`); if (saved.run.siteId === id) chosenRun = saved.run; } catch { /* Removed run: fall back to most recent. */ }
  }
  if (selection !== state.selection) return;
  state.activeSite = body.site;
  state.activeRun = chosenRun || body.runs[0] || null;
  $('pages-table').replaceChildren();
  $('empty-state').hidden = true;
  $('site-panel').hidden = false;
  $('active-site-name').textContent = body.site.name;
  $('active-site-url').textContent = body.site.url;
  $('active-site-url').href = body.site.url;
  updateConnectionBadge(body.site);
  renderSites();
  renderRun();
  renderHistory(body.runs);
  if (['discovering', 'crawling', 'generating', 'publishing'].includes(state.activeRun?.status)) startPolling();
}

function updateConnectionBadge(site) {
  const badge = $('connection-badge');
  const labels = { connected: 'Connected', failed: 'Connection failed', untested: 'Untested' };
  badge.textContent = labels[site.lastConnectionStatus] || site.lastConnectionStatus;
  badge.className = `status-badge ${site.lastConnectionStatus || 'untested'}`;
  badge.title = site.lastConnectionMessage || '';
}

function openNewSite() {
  $('site-form').reset();
  $('site-id').value = '';
  $('site-dialog-title').textContent = 'Register a site';
  $('delete-site').hidden = true;
  $('post-types').value = 'pages, posts';
  $('schema-prefix').value = 'rank_math_schema_';
  $('rich-key').value = 'rank_math_rich_snippet';
  toggleConnectionFields();
  $('site-dialog').showModal();
}

function editSite() {
  const site = state.activeSite;
  $('site-id').value = site.id;
  $('site-dialog-title').textContent = 'Edit site settings';
  $('delete-site').hidden = false;
  $('site-name').value = site.name;
  $('site-url').value = site.url;
  $('connection-type').value = site.connection.type;
  $('wp-username').value = site.connection.username || '';
  $('wp-password').value = '';
  $('helper-token').value = '';
  $('post-types').value = site.mapping.postTypes.join(', ');
  $('schema-prefix').value = site.mapping.schemaMetaPrefix;
  $('rich-key').value = site.mapping.richSnippetKey;
  $('content-fallback').checked = site.mapping.fallbackToContent;
  $('integration').value = site.mapping.integration || 'connector';
  $('rest-meta-key').value = site.mapping.restMetaKey || '';
  $('rest-encoding').value = site.mapping.restEncoding || 'json-string';
  $('rest-overrides').value = JSON.stringify(site.mapping.restOverrides || {}, null, 2);
  toggleConnectionFields();
  $('site-dialog').showModal();
}

function closeDialog() { $('site-dialog').close(); }

function toggleConnectionFields() {
  const helper = $('connection-type').value === 'helper';
  $('app-password-fields').hidden = helper;
  $('helper-fields').hidden = !helper;
  const direct = $('integration').value === 'rest-meta';
  $('rest-mapping-fields').hidden = !direct || helper;
  $('connector-help').hidden = direct || helper;
}

async function saveSite(event) {
  event.preventDefault();
  const id = $('site-id').value;
  let overrides;
  try { overrides = JSON.parse($('rest-overrides').value.trim() || '{}'); }
  catch { return notify('Post-type overrides must be valid JSON.', 'error'); }
  if ($('integration').value === 'rest-meta' && !$('rest-meta-key').value.trim() && !Object.keys(overrides || {}).length) return notify('Enter the registered metadata key, or configure post-type overrides.', 'error');
  const payload = {
    name: $('site-name').value, url: $('site-url').value,
    connection: {
      type: $('connection-type').value, username: $('wp-username').value,
      appPassword: $('wp-password').value, secretToken: $('helper-token').value
    },
    mapping: {
      integration: $('integration').value, restMetaKey: $('rest-meta-key').value.trim(),
      restEncoding: $('rest-encoding').value, restOverrides: overrides,
      postTypes: $('post-types').value.split(',').map(value => value.trim()).filter(Boolean),
      schemaMetaPrefix: $('schema-prefix').value.trim(), richSnippetKey: $('rich-key').value.trim(),
      fallbackToContent: $('content-fallback').checked
    }
  };
  try {
    const body = await api(id ? `/api/workspaces/sites/${id}` : '/api/workspaces/sites', {
      method: id ? 'PUT' : 'POST', body: JSON.stringify(payload)
    });
    closeDialog(); notify(id ? 'Site settings updated.' : 'Site registered. Test the connection next.', 'success');
    await loadSites(body.site.id);
  } catch (error) { notify(error.message, 'error'); }
}

async function deleteSite() {
  const site = state.activeSite;
  if (!site || !window.confirm(`Delete ${site.name} and all of its saved run history? This cannot be undone.`)) return;
  try {
    await api(`/api/workspaces/sites/${site.id}`, { method: 'DELETE' });
    closeDialog(); state.activeSite = null; state.activeRun = null;
    notify('Site and its run history were deleted.', 'success'); await loadSites();
  } catch (error) { notify(error.message, 'error'); }
}

async function testSite() {
  const button = $('test-site'); button.disabled = true; button.textContent = 'Testing…';
  try {
    const body = await api(`/api/workspaces/sites/${state.activeSite.id}/test`, { method: 'POST', body: '{}' });
    notify(body.result.message || 'WordPress connection succeeded.', 'success'); await selectSite(state.activeSite.id);
  } catch (error) { notify(error.message, 'error'); await selectSite(state.activeSite.id); }
  finally { button.disabled = false; button.textContent = 'Test connection'; }
}

async function discoverPages() {
  const button = $('start-crawl'); button.disabled = true; button.textContent = 'Discovering…';
  try {
    const urls = $('manual-urls').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const body = await api(`/api/workspaces/sites/${state.activeSite.id}/crawls`, {
      method: 'POST', body: JSON.stringify({ sitemapUrl: $('sitemap-url').value.trim(), postTypeFilter: $('page-filter').value, urls })
    });
    state.activeRun = body.run; renderRun(); await refreshHistory();
    notify('Crawl started. Pages and their content will appear as they are processed.', 'success');
    state.pendingAdvance = { runId: body.run.id, section: 'generate' };
    startPolling();
  } catch (error) { notify(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'Crawl site'; }
}

function initTheme() {
  const button = $('theme-toggle');
  if (!button) return;
  const apply = theme => {
    document.documentElement.dataset.theme = theme;
    button.querySelector('.icon').textContent = theme === 'dark' ? '☀️' : '🌙';
    button.querySelector('.label').textContent = theme === 'dark' ? 'Light' : 'Dark';
  };
  apply(localStorage.getItem('schema-theme') || 'light');
  button.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('schema-theme', theme); apply(theme);
  });
}

function selectedUrls() {
  return [...document.querySelectorAll('.page-select:checked')].map(input => input.value);
}

async function generateRun() {
  const urls = selectedUrls();
  if (!urls.length) return notify('Select at least one page first.', 'error');
  try {
    await api(`/api/workspaces/runs/${state.activeRun.id}/generate`, {
      method: 'POST', body: JSON.stringify({ urls, useAI: true, provider: $('ai-provider').value, apiKey: $('ai-key').value, model: selectedModel('ai-model') || undefined })
    });
    $('ai-key').value = '';
    state.pendingAdvance = { runId: state.activeRun.id, section: 'results' };
    state.activeRun.status = 'generating'; renderRun();
    notify('Generation started. This page will update as each URL completes.', 'success');
    startPolling();
  } catch (error) { notify(error.message, 'error'); }
}

function startPolling() {
  window.clearInterval(state.poller);
  const runId = state.activeRun.id;
  state.poller = window.setInterval(async () => {
    try {
      const body = await api(`/api/workspaces/runs/${runId}`);
      if (state.activeRun?.id !== runId) return;
      state.activeRun = body.run; renderRun();
      if (!['generating', 'discovering', 'crawling', 'publishing'].includes(body.run.status)) {
        window.clearInterval(state.poller); await refreshHistory();
        if (state.pendingAdvance?.runId === runId) {
          const next = state.pendingAdvance.section; state.pendingAdvance = null;
          if (next === 'generate' && body.run.pages.some(page => page.pageData)) navigateWorkflow(next);
          if (next === 'results' && body.run.pages.some(page => page.validation?.valid)) { navigateWorkflow(next); await publishRun(true); }
        }
      }
    } catch (error) { window.clearInterval(state.poller); notify(error.message, 'error'); }
  }, 1500);
}

async function publishRun(dryRun) {
  const urls = selectedUrls();
  if (!urls.length) return notify('Select generated pages first.', 'error');
  if (!dryRun && !window.confirm(`Apply "${$('schema-policy').selectedOptions[0].textContent}" to ${urls.length} page(s)? This changes public schema. A backup is kept for Undo.`)) return;
  try {
    const body = await api(`/api/workspaces/runs/${state.activeRun.id}/publish`, {
      method: 'POST', body: JSON.stringify({ urls, dryRun, schemaPolicy: $('schema-policy').value, acknowledgeConflicts: $('acknowledge-conflicts').checked })
    });
    notify(dryRun ? `Preview ready. Open Review for before/after and conflicts. Kept unchanged: ${body.results.filter(item => item.skipped).length}.` : `Saved: ${body.results.filter(item => item.stored).length}. Kept unchanged: ${body.results.filter(item => item.skipped).length}. Verified: ${body.results.filter(item => item.verified).length}.`, body.success ? 'success' : 'error');
    const refreshed = await api(`/api/workspaces/runs/${state.activeRun.id}`); state.activeRun = refreshed.run; renderRun(); await refreshHistory();
  } catch (error) { notify(error.message, 'error'); }
}

function renderRun() {
  syncNavigation();
  const run = state.activeRun;
  $('workflow-guide').textContent = !state.activeSite ? 'Start here: add your WordPress site, then save your AI key in AI Settings.' : !run ? 'Step 1: Test the connection, then click Crawl site.' : ['crawling', 'discovering'].includes(run.status) ? 'Crawling… AI Schema opens automatically when pages are ready.' : run.status === 'generating' ? 'AI is generating your schema. Review opens automatically when it is ready.' : currentSection() === 'sites' ? 'Crawl another batch, or continue to AI Schema using the pages below.' : currentSection() === 'generate' ? 'Select pages below, check your AI model, then click Generate AI schema → Review.' : 'Choose replace or remove, preview, open Review on each page, then approve and apply. Undo restores the previous state.';
  $('rollback-run').disabled = !run || ['generating', 'publishing', 'discovering', 'crawling'].includes(run.status) || !run.pages.some(page => page.writeReceipt && !page.writeReceipt.rolledBack);
  const oldSelections = new Map([...document.querySelectorAll('.page-select')].map(el => [el.value, el.checked]));
  if (!run) {
    $('run-title').textContent = 'No crawl yet'; $('run-status').textContent = 'Ready'; $('run-summary').replaceChildren();
    $('pages-table').innerHTML = '<p class="muted">Discover pages to begin.</p>';
    $('generate-run').disabled = true; $('preview-publish').disabled = true; $('publish-run').disabled = true; $('verify-run').disabled = true; $('start-crawl').disabled = false; $('run-message').textContent = ''; return;
  }
  $('run-title').textContent = `Run from ${new Date(run.createdAt).toLocaleString()}`;
  $('run-message').textContent = [run.error, run.discoveryWarning, run.limited ? 'Crawl limit reached. Increase MAX_CRAWL_PAGES or crawl additional URLs separately.' : ''].filter(Boolean).join(' ');
  $('run-status').textContent = run.status.replaceAll('_', ' ');
  $('run-status').className = `status-badge ${run.status}`;
  const metrics = [['Discovered', run.summary.discovered], ['Generated', run.summary.generated], ['Failed', run.summary.failed], ['Published', run.summary.published]];
  $('run-summary').replaceChildren(...metrics.map(([label, value]) => {
    const item = document.createElement('div'); const number = document.createElement('strong'); number.textContent = value;
    const text = document.createElement('span'); text.textContent = label; item.append(number, text); return item;
  }));
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th><input type="checkbox" id="select-all-pages" aria-label="Select all pages"></th><th>Page</th><th>Schema</th><th>Status</th></tr></thead>';
  const tbody = document.createElement('tbody');
  run.pages.forEach(page => {
    const row = document.createElement('tr');
    const selectCell = document.createElement('td'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'page-select'; checkbox.value = page.url; checkbox.checked = ['queued', 'crawled', 'generated', 'verification_pending', 'publish_failed'].includes(page.status); checkbox.setAttribute('aria-label', `Select ${page.title || page.url}`); selectCell.append(checkbox);
    const pageCell = document.createElement('td'); const link = document.createElement('a'); link.href = page.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = page.title || page.url; const url = document.createElement('small'); url.textContent = page.url; pageCell.append(link, url);
    const schemaCell = document.createElement('td'); schemaCell.textContent = page.schemaTypes?.join(', ') || '—';
    const review = document.createElement('button'); review.className = 'btn btn-secondary'; review.textContent = 'Review';
    review.addEventListener('click', () => {
      $('schema-review-url').textContent = page.url;
      $('schema-review-json').textContent = JSON.stringify(page.schema || {}, null, 2);
      $('schema-review-existing').textContent = JSON.stringify(page.existingReview?.existing || page.pageData?.existingSchema || [], null, 2);
      const preview = page.existingReview;
      $('schema-review-decision').textContent = preview ? [preview.skip ? 'Keep existing: no changes.' : preview.suppressRankMath ? preview.decision === 'remove-existing' ? 'Remove public Rank Math and app schema from this page. Underlying Rank Math settings remain for Undo.' : 'Suppress the Rank Math page graph and replace it with the AI graph below. Other plugin output remains.' : 'App-managed storage will be replaced; Rank Math/third-party nodes stay active.', preview.blocked, ...(preview.conflicts || []), preview.requiresAcknowledgement ? 'Explicit approval required.' : ''].filter(Boolean).join('\n') : 'Click Preview to fetch current WordPress schema before publishing.';
      $('schema-review-before').textContent = JSON.stringify(preview?.before || null, null, 2);
      $('schema-review-after').textContent = JSON.stringify(preview ? preview.after : page.schema || null, null, 2);
      $('schema-review-records').textContent = JSON.stringify({ insertions: page.insertionHistory, previousReceipts: page.receiptHistory, lastInsertion: page.writeReceipt, rollbacks: page.rollbackHistory }, null, 2);
      $('schema-review-content').textContent = page.pageData?.content || 'No crawled content.';
      $('schema-review-messages').textContent = [...(page.validation?.errors || []), ...(page.validation?.warnings || []), page.error, page.publishError, page.publishResult?.verificationMessage].filter(Boolean).join('\n');
      $('schema-dialog').showModal();
    });
    schemaCell.append(review);
    const statusCell = document.createElement('td'); const badge = document.createElement('span'); badge.className = `status-dot ${page.status}`; badge.textContent = page.status; badge.title = page.error || ''; statusCell.append(badge);
    const detail = document.createElement('small'); detail.textContent = page.error || page.publishError || page.decisionMessage || page.publishResult?.verificationMessage || page.preview?.verificationMessage || ''; statusCell.append(detail);
    if (oldSelections.has(page.url)) checkbox.checked = oldSelections.get(page.url);
    checkbox.addEventListener('change', updatePublishControls);
    row.append(selectCell, pageCell, schemaCell, statusCell); tbody.append(row);
  });
  table.append(tbody); $('pages-table').replaceChildren(table);
  $('select-all-pages')?.addEventListener('change', event => { document.querySelectorAll('.page-select').forEach(item => { item.checked = event.target.checked; }); updatePublishControls(); });
  const busy = ['generating', 'publishing', 'discovering', 'crawling'].includes(run.status);
  $('start-crawl').disabled = busy;
  $('generate-run').disabled = busy || !run.pages.length;
  const hasGenerated = run.pages.some(page => page.schema);
  $('preview-publish').disabled = busy || !hasGenerated;
  $('publish-run').disabled = busy || !hasGenerated;
  $('verify-run').disabled = busy || (!hasGenerated && !run.pages.some(page => page.status === 'schema_removed'));
  updatePublishControls();
}

function updatePublishControls() {
  const run = state.activeRun;
  const urls = selectedUrls();
  const all = $('select-all-pages');
  const count = document.querySelectorAll('.page-select').length;
  if (all) {
    all.checked = count > 0 && urls.length === count;
    all.indeterminate = urls.length > 0 && urls.length < count;
  }
  const pages = run?.pages.filter(page => urls.includes(page.url)) || [];
  const busy = !run || ['generating', 'publishing', 'discovering', 'crawling'].includes(run.status);
  const policy = $('schema-policy').value;
  $('preview-publish').disabled = busy || !pages.length || (policy !== 'remove-existing' && pages.some(page => !page.validation?.valid));
  $('publish-run').disabled = busy || !pages.length || pages.some(page => !page.existingReview || page.existingReview.decision !== policy || page.existingReview.blocked) || !$('acknowledge-conflicts').checked;
  $('publish-run').textContent = policy === 'remove-existing' ? '2. Remove schema from selected pages' : '2. Apply reviewed changes';
}

async function refreshHistory() {
  const body = await api(`/api/workspaces/sites/${state.activeSite.id}`); renderHistory(body.runs);
}

function renderHistory(runs) {
  const container = $('run-history'); container.replaceChildren();
  if (!runs.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No recorded runs.'; container.append(p); return; }
  runs.forEach(run => {
    const button = document.createElement('button'); button.className = `history-row${state.activeRun?.id === run.id ? ' active' : ''}`;
    const date = document.createElement('span'); date.textContent = new Date(run.createdAt).toLocaleString();
    const summary = document.createElement('span'); summary.textContent = `${run.summary.generated}/${run.summary.discovered} generated · ${run.summary.published} published`;
    const status = document.createElement('span'); status.className = `status-badge ${run.status}`; status.textContent = run.status.replaceAll('_', ' ');
    button.append(date, summary, status); button.addEventListener('click', async () => {
      try {
        window.clearInterval(state.poller);
        const body = await api(`/api/workspaces/runs/${run.id}`); state.activeRun = body.run; renderRun(); renderHistory(runs);
        if (['discovering', 'crawling', 'generating', 'publishing'].includes(body.run.status)) startPolling();
      } catch (error) { notify(error.message, 'error'); }
    }); container.append(button);
  });
}
