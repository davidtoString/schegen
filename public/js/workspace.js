const state = { sites: [], activeSite: null, activeRun: null, poller: null, wizardStep: 'crawl', schemaTypes: [], meta: { kinds: {}, buildable: [], businessTypes: [] }, plans: {}, reviewSchema: null, engine: 'rules' };
const WIZARD_STEPS = ['crawl', 'choose', 'generate', 'review', 'publish'];
const BUSY = ['discovering', 'crawling', 'generating', 'publishing'];

const $ = id => document.getElementById(id);
function savedContext() { try { return JSON.parse(sessionStorage.getItem('schematic-context') || '{}'); } catch { return {}; } }
function syncNavigation(replace = true) {
  const url = new URL(window.location.href);
  if (state.activeSite) url.searchParams.set('site', state.activeSite.id); else url.searchParams.delete('site');
  if (state.activeRun) url.searchParams.set('run', state.activeRun.id); else url.searchParams.delete('run');
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
  try { sessionStorage.setItem('schematic-context', JSON.stringify({ site: state.activeSite?.id, run: state.activeRun?.id })); } catch { /* URL still preserves context. */ }
}

// Open a run where its work left off: schema → Review, crawled pages → Choose, else Crawl.
function resetWizard() {
  const pages = state.activeRun?.pages || [];
  state.wizardStep = pages.some(page => page.schema) ? 'review' : pages.some(page => page.pageData) ? 'choose' : 'crawl';
}

function setWizardStep(step) {
  state.wizardStep = step;
  renderWizard();
}

function guideText(run) {
  if (!state.activeSite) return 'Start here: add your WordPress site.';
  if (!run) return 'Click Crawl site to find the pages on this site.';
  if (run.status === 'discovering') return 'Finding pages…';
  if (run.status === 'crawling') return `Reading pages… ${run.progress ? `${run.progress.done} of ${run.progress.total}.` : ''}`;
  if (run.status === 'generating') return `Generating schema… ${run.progress ? `${run.progress.done} of ${run.progress.total} pages.` : ''}`;
  if (run.status === 'publishing') return `Publishing to the site… ${run.progress ? `${run.progress.done} of ${run.progress.total} pages.` : ''}`;
  switch (state.wizardStep) {
    case 'crawl': return 'Crawl the site to list its pages.';
    case 'choose': return 'Tick the pages to create schema for and set their types.';
    case 'generate': return 'Generate schema for the ticked pages.';
    case 'review': return 'Compare the new schema with what is on the site now.';
    case 'publish': return 'Publish the ticked pages to the site.';
    default: return '';
  }
}

function renderWizard() {
  document.querySelectorAll('[data-wizard-step]').forEach(panel => { panel.hidden = panel.dataset.wizardStep !== state.wizardStep; });
  const currentIndex = WIZARD_STEPS.indexOf(state.wizardStep);
  const pages = state.activeRun?.pages || [];
  // A step is "done" when its work exists in this run; every step can be opened at any time.
  const stepDone = { crawl: pages.some(page => page.pageData), choose: pages.some(page => page.schema), generate: pages.some(page => page.schema), review: pages.some(page => page.writeReceipt), publish: pages.some(page => page.writeReceipt && !page.writeReceipt.rolledBack) };
  document.querySelectorAll('.wizard-step').forEach(button => {
    const index = WIZARD_STEPS.indexOf(button.dataset.step);
    button.classList.toggle('active', index === currentIndex);
    button.classList.toggle('done', index !== currentIndex && Boolean(stepDone[button.dataset.step]));
    button.classList.toggle('reachable', index !== currentIndex);
    if (index === currentIndex) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  });
  $('workflow-guide').textContent = guideText(state.activeRun);
  // While a crawl, generation or publish runs, the guide becomes a visible progress strip.
  const run = state.activeRun;
  const busy = BUSY.includes(run?.status);
  $('workflow-guide').classList.toggle('busy', busy);
  const { done = 0, total = 0 } = (busy && run.progress) || {};
  $('workflow-guide').style.setProperty('--progress', total ? `${Math.round((done / total) * 100)}%` : '0%');
  updatePublishControls();
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  $('open-help').addEventListener('click', () => $('help-dialog').showModal());
  document.querySelector('[data-action="open-help"]')?.addEventListener('click', event => { event.preventDefault(); $('help-dialog').showModal(); });
  $('close-help').addEventListener('click', () => $('help-dialog').close());
  $('close-help-footer').addEventListener('click', () => $('help-dialog').close());
  $('open-ai-settings').addEventListener('click', openAISettings);
  $('close-ai-settings').addEventListener('click', () => $('ai-settings-dialog').close());
  $('ai-settings-dialog').addEventListener('close', () => {
    for (const provider of ['openai', 'gemini']) $(`settings-${provider}-key`).value = '';
  });
  $('ai-settings-form').addEventListener('submit', saveAISettings);
  $('ai-provider').addEventListener('change', applyAIProvider);
  loadAISettings().catch(error => notify(error.message, 'error'));
  document.querySelectorAll('.wizard-step').forEach(button => button.addEventListener('click', () => setWizardStep(button.dataset.step)));
  document.querySelectorAll('.step-next').forEach(button => button.addEventListener('click', () => {
    if (!selectedUrls().length) return notify('Tick at least one page first.', 'error');
    setWizardStep(button.dataset.next);
  }));
  window.addEventListener('popstate', async () => {
    const query = new URLSearchParams(window.location.search);
    try {
      const siteId = query.get('site');
      if (siteId && (siteId !== state.activeSite?.id || query.get('run') !== state.activeRun?.id)) await selectSite(siteId, query.get('run'));
    } catch (error) { notify(error.message, 'error'); }
  });
  $('add-site').addEventListener('click', openNewSite);
  document.querySelector('[data-action="new-site"]').addEventListener('click', openNewSite);
  $('close-dialog').addEventListener('click', closeDialog);
  $('cancel-dialog').addEventListener('click', closeDialog);
  $('site-form').addEventListener('submit', saveSite);
  $('delete-site').addEventListener('click', deleteSite);
  $('test-site').addEventListener('click', testSite);
  $('edit-site').addEventListener('click', editSite);
  $('start-crawl').addEventListener('click', discoverPages);
  $('generate-run').addEventListener('click', generateRun);
  $('publish-run').addEventListener('click', publishRun);
  $('rollback-run').addEventListener('click', async () => {
    const urls = selectedUrls().filter(url => state.activeRun.pages.find(page => page.url === url)?.writeReceipt?.rolledBack === false);
    if (!urls.length) return notify('Tick published pages to undo.', 'error');
    if (!window.confirm(`Undo the last publish on ${urls.length} page(s)? Their previous schema (including Rank Math's) comes back.`)) return;
    try {
      const body = await api(`/api/workspaces/runs/${state.activeRun.id}/rollback`, { method: 'POST', body: JSON.stringify({ urls }) });
      state.activeRun = body.run; renderRun(); await refreshHistory();
      notify(`Restored: ${body.results.filter(result => result.restored).length}/${body.results.length}. Review each page's result.`, body.success ? 'success' : 'error');
    } catch (error) { notify(error.message, 'error'); }
  });
  $('close-schema').addEventListener('click', () => $('schema-dialog').close());
  $('recrawl-failed').addEventListener('click', recrawlFailed);
  $('history-select-all').addEventListener('change', event => { document.querySelectorAll('.history-select').forEach(box => { box.checked = event.target.checked; }); updateHistorySelection(); });
  $('delete-runs').addEventListener('click', () => deleteRuns([...document.querySelectorAll('.history-select:checked')].map(box => box.value)));
  $('apply-types').addEventListener('click', () => {
    const urls = selectedUrls();
    if (!urls.length) return notify('Select pages first.', 'error');
    const plan = readPlan('type-options', 'type-more');
    urls.forEach(url => { state.plans[url] = plan; });
    renderRun(); notify(`Schema types set for ${urls.length} page(s).`, 'success');
  });
  $('plan-form').addEventListener('submit', () => { state.plans[state.planUrl] = readPlan('plan-type-options', 'plan-more'); renderRun(); });
  $('plan-auto').addEventListener('click', () => { state.plans[state.planUrl] = { types: [] }; $('plan-dialog').close(); renderRun(); });
  $('plan-cancel').addEventListener('click', () => $('plan-dialog').close());
  document.querySelectorAll('[data-export]').forEach(button => button.addEventListener('click', () => {
    const run = state.activeRun;
    if (!run?.pages.some(page => page.schema)) return notify('Generate schema first.', 'error');
    const params = new URLSearchParams({ format: button.dataset.export });
    const urls = selectedUrls();
    if (urls.length && urls.length < run.pages.length) urls.forEach(url => params.append('urls', url));
    window.location.href = `/api/workspaces/runs/${run.id}/export?${params}`;
  }));
  $('download-backups').addEventListener('click', () => { window.location.href = `/api/workspaces/sites/${state.activeSite.id}/backups`; });
  $('copy-json').addEventListener('click', () => copyText(JSON.stringify(state.reviewSchema, null, 2)));
  $('copy-script').addEventListener('click', () => copyText(`<script type="application/ld+json">\n${JSON.stringify(state.reviewSchema, null, 2).replace(/</g, '\\u003c')}\n</script>`));
  document.querySelectorAll('input[name="engine"]').forEach(input => input.addEventListener('change', () => applyEngine(input.value)));
  $('edit-profile').addEventListener('click', openProfile);
  $('close-profile').addEventListener('click', () => $('profile-dialog').close());
  $('cancel-profile').addEventListener('click', () => $('profile-dialog').close());
  $('detect-profile').addEventListener('click', () => detectProfile(false));
  $('profile-form').addEventListener('submit', saveProfile);
  loadSchemaTypes().catch(error => notify(error.message, 'error'));
  initScrollNav();
  loadSites();
});

async function copyText(text) {
  if (!state.reviewSchema) return notify('This page has no generated schema yet.', 'error');
  try { await navigator.clipboard.writeText(text); notify('Copied to clipboard.', 'success'); }
  catch { notify('Copy failed. Select the JSON below and copy it manually.', 'error'); }
}

async function loadSchemaTypes() {
  const body = await api('/api/workspaces/schema-types');
  state.schemaTypes = body.types;
  state.meta = { kinds: body.kinds, buildable: body.buildable, businessTypes: body.businessTypes, moreTypes: body.moreTypes, businessRequired: body.businessRequired || [] };
  $('business-types').replaceChildren(...body.businessTypes.map(type => Object.assign(document.createElement('option'), { value: type })));
  renderTypeOptions('type-options', []);
  renderMoreTypes('type-more', []);
  applyEngine(state.engine);
}
function applyEngine(engine) {
  state.engine = engine;
  $('ai-fields').hidden = engine !== 'ai';
  $('type-more').hidden = engine !== 'ai';
  $('type-picker-hint').textContent = engine === 'rules'
    ? 'By default each page gets the types for its kind (Business profile → Page rules). To change the ticked pages, tick types here and click the button.'
    : 'Tick types for the ticked pages, or leave all unticked to let the AI choose.';
  // The picker lists what this engine can build; keep any ticks that still apply.
  renderTypeOptions('type-options', readPlan('type-options', 'type-more').types);
  if (state.activeRun) renderRun();
}
// Types the current engine can produce: the rules builder makes a fixed set, AI anything.
function availableTypes() {
  return state.engine === 'rules' ? state.schemaTypes.filter(item => state.meta.buildable.includes(item.type)) : state.schemaTypes;
}
// The business option shows each site's own type from its profile (HVACBusiness, Plumber, …).
function businessLabel() { return state.activeSite?.profile?.type || 'LocalBusiness'; }
function renderTypeOptions(containerId, selected) {
  $(containerId).replaceChildren(...availableTypes().map(({ type, hint }) => {
    const label = document.createElement('label'); const input = document.createElement('input');
    input.type = 'checkbox'; input.value = type; input.checked = selected.includes(type) || (type === 'LocalBusiness' && selected.includes(businessLabel()));
    const text = document.createElement('span'); text.textContent = type === 'LocalBusiness' ? businessLabel() : type;
    const small = document.createElement('small'); small.textContent = type === 'LocalBusiness' ? 'Your business, from the business profile' : hint; text.append(small);
    label.append(input, text); return label;
  }));
}
function readPlan(containerId, moreId) {
  const checked = id => [...$(id).querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
  return { types: [...new Set([...checked(containerId), ...($(moreId).hidden ? [] : checked(moreId))])] };
}
// "More schema.org types": grouped checkboxes with a filter and a selected count.
function renderMoreTypes(id, selected) {
  const box = $(id); const shown = new Set(state.meta.moreTypes.map(item => item.type));
  // Types picked earlier that aren't in any list (old free-text entries) stay selectable.
  const mainTypes = new Set(state.schemaTypes.map(item => item.type));
  const extra = selected.filter(type => !shown.has(type) && !mainTypes.has(type)).map(type => ({ type, group: 'Your types' }));
  const groups = new Map();
  for (const item of [...extra, ...state.meta.moreTypes]) groups.set(item.group, [...(groups.get(item.group) || []), item.type]);
  box.querySelector('.more-options').replaceChildren(...[...groups].map(([group, types]) => {
    const section = document.createElement('div'); section.className = 'more-group';
    section.append(Object.assign(document.createElement('span'), { className: 'more-group-title', textContent: group }));
    const grid = document.createElement('div'); grid.className = 'more-grid';
    grid.append(...types.map(type => {
      const label = document.createElement('label'); const input = document.createElement('input');
      input.type = 'checkbox'; input.value = type; input.checked = selected.includes(type);
      label.append(input, document.createTextNode(type)); return label;
    }));
    section.append(grid); return section;
  }));
  const count = () => { const n = box.querySelectorAll('.more-options input:checked').length; box.querySelector('.more-count').textContent = n ? `(${n} selected)` : ''; };
  const filter = box.querySelector('.more-filter');
  filter.value = '';
  filter.oninput = () => {
    const term = filter.value.trim().toLowerCase();
    box.querySelectorAll('.more-group').forEach(section => {
      let any = false;
      section.querySelectorAll('label').forEach(label => { const match = label.textContent.toLowerCase().includes(term); label.hidden = !match; any ||= match; });
      section.hidden = !any;
    });
  };
  box.querySelector('.more-options').onchange = count;
  box.open = extra.length > 0 || selected.some(type => shown.has(type));
  count();
}
function planFor(page) { return state.plans[page.url] || (state.engine === 'rules' ? page.rulesPlan : page.schemaPlan) || null; }
function describePlan(plan, page) {
  const kind = state.meta.kinds[page?.kind]?.label;
  if (plan?.types?.length) return `${kind ? `${kind} · ` : ''}Types: ${plan.types.map(type => (type === 'LocalBusiness' ? businessLabel() : type)).join(', ')}`;
  if (state.engine === 'rules') return `${kind || 'Page'} · page rules`;
  return `${kind ? `${kind} · ` : ''}Types: picker above, or AI chooses`;
}
function openPlan(page) {
  const kindRule = state.engine === 'rules' ? state.activeSite?.rules?.[page.kind] : null;
  const plan = planFor(page) || { types: kindRule || [] };
  state.planUrl = page.url;
  $('plan-url').textContent = page.url;
  $('plan-auto').textContent = state.engine === 'rules' ? 'Use page rules' : 'Let AI choose';
  renderTypeOptions('plan-type-options', plan.types || []);
  $('plan-more').hidden = state.engine === 'rules';
  renderMoreTypes('plan-more', plan.types || []);
  $('plan-dialog').showModal();
}

// Pages never read: failed, or left queued/mid-crawl by an interrupted run.
function unreadPages(run) {
  if (!run || ['discovering', 'crawling', 'generating', 'publishing'].includes(run.status)) return [];
  return run.pages.filter(page => !page.pageData && ['failed', 'queued', 'crawling'].includes(page.status));
}
async function recrawlFailed() {
  const urls = unreadPages(state.activeRun).map(page => page.url);
  if (!urls.length) return;
  try {
    await api(`/api/workspaces/runs/${state.activeRun.id}/recrawl`, { method: 'POST', body: JSON.stringify({ urls }) });
    state.activeRun.status = 'crawling'; renderRun();
    notify(`Reading ${urls.length} page(s).`, 'success'); startPolling();
  } catch (error) { notify(error.message, 'error'); }
}

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
  $('ai-configuration-status').textContent = settings?.hasSavedKey ? `Using the saved key ${settings.savedKeyHint}.` : settings?.hasEnvironmentKey ? `Using the server environment key ${settings.environmentKeyHint}.` : 'No saved key. Open AI Settings to configure this provider.';
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
      $(`settings-${provider}-status`).textContent = `${settings.hasSavedKey ? `Saved key: ${settings.savedKeyHint} (used for generation)` : 'No key saved here'}${settings.hasEnvironmentKey ? ` · Server environment key: ${settings.environmentKeyHint}${settings.hasSavedKey ? ' (backup)' : ' (used for generation)'}` : ''}. Validity is checked when you generate.`;
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
    button.dataset.siteId = site.id;
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
  resetWizard();
  syncNavigation();
  $('empty-state').hidden = false;
  $('site-panel').hidden = true;
}

async function selectSite(id, preferredRun) {
  window.clearInterval(state.poller);
  const selection = state.selection = (state.selection || 0) + 1;
  // Show the switch immediately; the data arrives after.
  if (state.activeSite?.id !== id) {
    document.querySelectorAll('.site-item').forEach(item => item.classList.toggle('active', item.dataset.siteId === id));
    $('site-panel').classList.add('loading');
  }
  let body;
  try { body = await api(`/api/workspaces/sites/${id}?run=${encodeURIComponent(preferredRun || 'latest')}`); }
  finally { if (selection === state.selection) $('site-panel').classList.remove('loading'); }
  let chosenRun = body.run?.id === preferredRun || !preferredRun ? body.run : null;
  if (preferredRun && !chosenRun) {
    try { const saved = await api(`/api/workspaces/runs/${encodeURIComponent(preferredRun)}`); if (saved.run.siteId === id) chosenRun = saved.run; } catch { /* Removed run: fall back to most recent. */ }
  }
  if (selection !== state.selection) return;
  state.activeSite = body.site;
  state.activeRun = chosenRun || body.run || null;
  resetWizard();
  $('pages-table').replaceChildren();
  $('empty-state').hidden = true;
  $('site-panel').hidden = false;
  $('active-site-name').textContent = body.site.name;
  $('active-site-url').textContent = body.site.url;
  $('active-site-url').href = body.site.url;
  updateConnectionBadge(body.site);
  renderProfile(body.site);
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
  $('site-dialog').showModal();
}

function editSite() {
  const site = state.activeSite;
  $('site-id').value = site.id;
  $('site-dialog-title').textContent = 'Edit site settings';
  $('delete-site').hidden = false;
  $('site-name').value = site.name;
  $('site-url').value = site.url;
  $('wp-username').value = site.connection.username || '';
  $('wp-password').value = '';
  $('org-image').value = site.organization?.image || '';
  $('site-dialog').showModal();
}

function closeDialog() { $('site-dialog').close(); }

async function saveSite(event) {
  event.preventDefault();
  const id = $('site-id').value;
  const payload = {
    name: $('site-name').value, url: $('site-url').value,
    connection: {
      type: 'application-password', username: $('wp-username').value,
      appPassword: $('wp-password').value
    },
    organization: { image: $('org-image').value.trim() }
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
      method: 'POST', body: JSON.stringify({ sitemapUrl: $('sitemap-url').value.trim(), urls })
    });
    state.activeRun = body.run; renderRun(); await refreshHistory();
    notify('Crawl started. Pages appear in the list below as they are read.', 'success');
    state.afterPoll = async () => { if (state.activeRun.pages.some(page => page.pageData)) setWizardStep('choose'); };
    startPolling();
  } catch (error) { notify(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'Crawl site'; }
}

function initTheme() {
  const button = $('theme-toggle');
  if (!button) return;
  const apply = theme => {
    document.documentElement.dataset.theme = theme;
    button.querySelector('.label').textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  };
  // The <head> script already applied the saved theme, or the system one, before first paint.
  apply(document.documentElement.dataset.theme || 'light');
  button.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('schema-theme', theme); } catch { /* Theme still applies for this visit. */ }
    apply(theme);
  });
}

function selectedUrls() {
  return [...document.querySelectorAll('.page-select:checked')].map(input => input.value);
}

async function generateRun() {
  const urls = selectedUrls();
  if (!urls.length) return notify('Select at least one page first.', 'error');
  if (state.engine === 'rules' && !state.activeSite.profile?.name) { notify('Set up the business profile first. It is filled in for you; check it and save.', 'info'); return openProfile(); }
  try {
    await api(`/api/workspaces/runs/${state.activeRun.id}/generate`, {
      method: 'POST', body: JSON.stringify({ urls, engine: state.engine, ...generationPlans(urls), provider: $('ai-provider').value, model: selectedModel('ai-model') || undefined })
    });
    state.activeRun.status = 'generating'; renderRun();
    state.afterPoll = async () => {
      const made = state.activeRun.pages.filter(page => urls.includes(page.url) && page.schema).length;
      notify(`Schema ready for ${made} of ${urls.length} page(s). Compare them, then publish.`, made === urls.length ? 'success' : 'error');
      if (made) setWizardStep('review');
    };
    startPolling();
  } catch (error) { notify(error.message, 'error'); }
}

function generationPlans(urls) {
  const plans = Object.fromEntries(urls.filter(url => state.plans[url]).map(url => [url, state.plans[url]]));
  const picker = readPlan('type-options', 'type-more');
  return { plans, ...(state.engine === 'ai' && picker.types.length ? { defaultPlan: picker } : {}) };
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
        const afterPoll = state.afterPoll; state.afterPoll = null;
        if (afterPoll) await afterPoll();
      }
    } catch (error) { window.clearInterval(state.poller); notify(error.message, 'error'); }
  }, 1500);
}

async function publishRun() {
  const ticked = selectedUrls();
  const ready = state.activeRun.pages.filter(page => ticked.includes(page.url) && page.schema && page.validation?.valid).map(page => page.url);
  if (!ready.length) return notify('Tick pages that have schema ready.', 'error');
  if (BUSY.includes(state.activeRun?.status)) return notify('Wait for the current step to finish.', 'info');
  const skipped = ticked.length - ready.length;
  if (!window.confirm(`Publish schema to ${ready.length} page(s) on ${new URL(state.activeSite.url).host}?${skipped ? ` (${skipped} ticked page(s) without ready schema are skipped.)` : ''}\n\nThis replaces their current schema. Undo puts it back.`)) return;
  try {
    await api(`/api/workspaces/runs/${state.activeRun.id}/publish`, { method: 'POST', body: JSON.stringify({ urls: ready, direct: true }) });
    state.activeRun.status = 'publishing';
    state.activeRun.progress = { done: 0, total: ready.length, dryRun: false };
    renderRun();
    // Runs on the server in the background; report from the finished run's lastPublish.
    state.afterPoll = async () => {
      const results = state.activeRun.lastPublish?.results || [];
      const published = results.filter(item => item.stored).length;
      const live = results.filter(item => item.verified).length;
      const failed = results.filter(item => !item.success).length;
      notify(`Published ${published} page(s)${published ? `; ${live} confirmed on the live site${published > live ? ` (${published - live} waiting on the site's cache)` : ''}` : ''}.${failed ? ` ${failed} failed; see their status below.` : ''}`, failed ? 'error' : 'success');
    };
    startPolling();
  } catch (error) { notify(error.message, 'error'); }
}

const PAGE_STATUS = { queued: 'Waiting', crawling: 'Reading', crawled: 'Read', failed: 'Failed', generating: 'Generating', generated: 'Schema ready', invalid: 'Needs fixes', publish_failed: 'Publish failed', published: 'Published', verification_pending: 'Published, live check pending', schema_removed: 'Removed', rolled_back: 'Undone' };
const RUN_STATUS = { discovering: 'Finding pages', crawling: 'Reading pages', ready: 'Crawled', generating: 'Generating', publishing: 'Publishing', completed: 'Done', completed_with_errors: 'Done, some pages need attention', failed: 'Failed', interrupted: 'Interrupted' };

// Every @type in a set of JSON-LD blocks, for the Compare summary.
function schemaTypesOf(value) {
  const types = [];
  const walk = item => { if (Array.isArray(item)) item.forEach(walk); else if (item && typeof item === 'object') { if (item['@graph']) walk(item['@graph']); else if (item['@type']) types.push(...[].concat(item['@type'])); } };
  walk(value);
  return [...new Set(types)];
}
// Side-by-side line diff (longest common subsequence) of two pretty-printed JSON documents.
function renderDiff(before, after) {
  const a = before ? JSON.stringify(before, null, 2).split('\n') : [];
  const b = after ? JSON.stringify(after, null, 2).split('\n') : [];
  const ops = [];
  if (a.length * b.length > 4e6) { a.forEach(line => ops.push(['del', line])); b.forEach(line => ops.push(['add', line])); }
  else {
    const width = b.length + 1; const lcs = new Uint16Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    let i = 0; let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { ops.push(['same', a[i]]); i++; j++; }
      else if (j < b.length && (i === a.length || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) { ops.push(['add', b[j]]); j++; }
      else { ops.push(['del', a[i]]); i++; }
    }
  }
  const rows = []; let dels = []; let adds = [];
  const flush = () => { for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k], adds[k]]); dels = []; adds = []; };
  for (const [kind, line] of ops) { if (kind === 'same') { flush(); rows.push([{ kind, line }, { kind, line }]); } else (kind === 'del' ? dels : adds).push({ kind, line }); }
  flush();
  const cell = item => { const el = document.createElement('div'); el.className = `diff-line ${item ? item.kind : 'empty'}`; el.textContent = item ? item.line : ''; return el; };
  const head = (text) => Object.assign(document.createElement('div'), { className: 'diff-head', textContent: text });
  $('schema-diff').replaceChildren(head('On the site now'), head('New schema'), ...rows.flatMap(([left, right]) => [cell(left), cell(right)]));
  if (!a.length) $('schema-diff').children[2]?.replaceWith(Object.assign(cell(null), { textContent: 'No schema on the page now.' }));
}
async function openCompare(page, button) {
  button.disabled = true;
  let detail = page; let live = null;
  try {
    const [pageBody, liveBody] = await Promise.all([
      api(`/api/workspaces/runs/${state.activeRun.id}/page?url=${encodeURIComponent(page.url)}`),
      api(`/api/workspaces/runs/${state.activeRun.id}/live?url=${encodeURIComponent(page.url)}`).catch(() => null)
    ]);
    detail = pageBody.page; live = liveBody;
  } catch (error) { notify(error.message, 'error'); }
  finally { button.disabled = false; }
  const pageData = detail.pageData || {};
  const before = live ? live.schema : pageData.existingSchema || [];
  state.reviewSchema = page.schema || null;
  $('schema-review-title').textContent = page.title || 'Schema';
  $('schema-review-url').textContent = page.url;
  $('compare-before-types').textContent = schemaTypesOf(before).join(', ') || 'No schema';
  $('compare-after-types').textContent = schemaTypesOf(page.schema).join(', ') || 'Not generated yet';
  $('compare-source').textContent = live ? `Live page checked ${new Date(live.checkedAt).toLocaleTimeString()}` : 'Live page unavailable; showing what the crawl found';
  // A page usually has one JSON-LD block; compare it directly so both sides line up.
  renderDiff(before.length === 1 ? before[0] : before.length ? before : null, page.schema || null);
  const made = page.generation?.engine === 'rules' ? 'Built by rules from the business profile.' : page.generation?.engine === 'ai' ? `Written by AI: ${page.generation.provider} ${page.generation.model}${page.generation.keyHint ? `, ${page.generation.keySource || 'key'} ${page.generation.keyHint}` : ''}.` : '';
  const publishError = page.status === 'publish_failed' ? page.publishError : '';
  const messages = [made, pageData.fetchWarning, ...(page.validation?.errors || []), ...(page.validation?.warnings || []), page.error, publishError, page.writeReceipt && !page.writeReceipt.rolledBack ? page.publishResult?.verificationMessage : ''].filter(Boolean);
  $('schema-review-messages').hidden = !messages.length;
  $('schema-review-messages').replaceChildren(...messages.map(text => Object.assign(document.createElement('p'), { textContent: text })));
  $('schema-review-records').textContent = JSON.stringify({ lastPublish: page.writeReceipt, earlier: page.receiptHistory, undo: page.rollbackHistory }, null, 2);
  $('schema-review-content').textContent = pageData.content || 'No crawled content.';
  $('schema-dialog').showModal();
}

function renderRun() {
  syncNavigation();
  const run = state.activeRun;
  const oldSelections = new Map([...document.querySelectorAll('.page-select')].map(el => [el.value, el.checked]));
  if (!run) {
    $('run-title').textContent = 'No crawl yet'; $('run-status').textContent = 'Ready'; $('run-summary').replaceChildren();
    $('pages-table').innerHTML = '<p class="muted">Discover pages to begin.</p>';
    $('start-crawl').disabled = false; $('recrawl-failed').hidden = true; $('rollback-run').disabled = true; $('run-message').textContent = '';
    renderWizard();
    return;
  }
  $('run-title').textContent = `Run from ${new Date(run.createdAt).toLocaleString()}`;
  $('run-message').textContent = [run.error, run.discoveryWarning, run.limited ? 'Crawl limit reached. Increase MAX_CRAWL_PAGES or crawl additional URLs separately.' : ''].filter(Boolean).join(' ');
  $('run-status').textContent = RUN_STATUS[run.status] || run.status.replaceAll('_', ' ');
  $('run-status').className = `status-badge ${run.status}`;
  const metrics = [['Pages', run.summary.discovered], ['Schema ready', run.summary.generated], ['Published', run.summary.published], ['Failed', run.summary.failed]];
  $('run-summary').replaceChildren(...metrics.map(([label, value]) => {
    const item = document.createElement('div'); const number = document.createElement('strong'); number.textContent = value;
    const text = document.createElement('span'); text.textContent = label; item.append(number, text); return item;
  }));
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th><input type="checkbox" id="select-all-pages" aria-label="Select all pages"></th><th>Page</th><th>Schema</th><th>Status</th></tr></thead>';
  const tbody = document.createElement('tbody');
  run.pages.forEach(page => {
    const row = document.createElement('tr');
    const selectCell = document.createElement('td'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'page-select'; checkbox.value = page.url; const canonicalElsewhere = page.pageData?.canonical && page.pageData.canonical.replace(/\/$/, '') !== page.url.replace(/\/$/, '');
    checkbox.checked = !canonicalElsewhere && ['queued', 'crawled', 'generated', 'publish_failed'].includes(page.status); checkbox.setAttribute('aria-label', `Select ${page.title || page.url}`); selectCell.append(checkbox);
    const pageCell = document.createElement('td'); const link = document.createElement('a'); link.href = page.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = page.title || page.url; const url = document.createElement('small'); url.textContent = page.url; pageCell.append(link, url);
    const schemaCell = document.createElement('td'); schemaCell.textContent = page.schemaTypes?.join(', ') || '—';
    const review = document.createElement('button'); review.className = 'btn btn-secondary'; review.textContent = 'Compare';
    review.disabled = !page.schema; review.title = page.schema ? 'Compare with the schema on the site now' : 'Generate schema first';
    review.addEventListener('click', () => openCompare(page, review));
    const planText = document.createElement('span'); planText.className = 'plan-summary'; planText.textContent = describePlan(planFor(page), page);
    const planButton = document.createElement('button'); planButton.className = 'btn btn-secondary'; planButton.textContent = 'Types';
    planButton.disabled = !page.pageData; planButton.addEventListener('click', () => openPlan(page));
    schemaCell.append(planText, review, planButton);
    const statusCell = document.createElement('td'); const badge = document.createElement('span'); badge.className = `status-dot ${page.status}`; badge.textContent = PAGE_STATUS[page.status] || page.status; badge.title = page.error || ''; statusCell.append(badge);
    const detail = document.createElement('small'); detail.textContent = page.error || (page.status === 'publish_failed' ? page.publishError : '') || (page.writeReceipt && !page.writeReceipt.rolledBack ? page.publishResult?.verificationMessage : '') || page.pageData?.fetchWarning || ''; statusCell.append(detail);
    if (oldSelections.has(page.url)) checkbox.checked = oldSelections.get(page.url);
    checkbox.addEventListener('change', updatePublishControls);
    row.append(selectCell, pageCell, schemaCell, statusCell); tbody.append(row);
  });
  table.append(tbody); $('pages-table').replaceChildren(table);
  $('select-all-pages')?.addEventListener('change', event => { document.querySelectorAll('.page-select').forEach(item => { item.checked = event.target.checked; }); updatePublishControls(); });
  const busy = ['generating', 'publishing', 'discovering', 'crawling'].includes(run.status);
  $('start-crawl').disabled = busy;
  const unread = unreadPages(run);
  $('recrawl-failed').hidden = !unread.length;
  $('recrawl-failed').textContent = `Resume / retry ${unread.length} page${unread.length === 1 ? '' : 's'}`;
  $('recrawl-failed').disabled = busy;
  $('rollback-run').disabled = busy || !run.pages.some(page => page.writeReceipt && !page.writeReceipt.rolledBack);
  renderWizard();
}

function renderSelectionSummary(urls, total, run) {
  const text = run && total ? (urls.length ? `${urls.length} of ${total} pages ticked.` : 'No pages ticked.') : '';
  document.querySelectorAll('.selection-hint').forEach(el => { el.textContent = text; });
  if ($('selection-summary')) $('selection-summary').textContent = '';
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
  renderSelectionSummary(urls, count, run);
  const pages = run?.pages.filter(page => urls.includes(page.url)) || [];
  const busy = !run || BUSY.includes(run.status);
  const readable = pages.filter(page => page.pageData).length;
  const publishable = pages.filter(page => page.schema && page.validation?.valid).length;
  $('crawl-continue').disabled = busy || !run?.pages.some(page => page.pageData);
  $('choose-continue').disabled = busy || !readable;
  $('generate-run').disabled = busy || !readable;
  $('generate-run').textContent = readable ? `Generate schema for ${readable} page${readable === 1 ? '' : 's'}` : 'Generate schema';
  $('generate-summary').textContent = `Using ${state.engine === 'rules' ? 'Rules (business profile and page rules)' : 'AI'}. Change this in Choose.`;
  $('review-continue').disabled = busy || !pages.some(page => page.schema);
  $('publish-run').disabled = busy || !publishable;
  $('publish-run').textContent = publishable ? `Publish ${publishable} page${publishable === 1 ? '' : 's'} to site` : 'Publish to site';
  $('rollback-run').disabled = busy || !pages.some(page => page.writeReceipt && !page.writeReceipt.rolledBack);
}

async function refreshHistory() {
  const body = await api(`/api/workspaces/sites/${state.activeSite.id}`); renderHistory(body.runs);
}

const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';
function renderHistory(runs) {
  state.historyRuns = runs;
  const container = $('run-history'); container.replaceChildren();
  $('history-actions').hidden = !runs.length;
  $('history-select-all').checked = false;
  if (!runs.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No recorded runs.'; container.append(p); updateHistorySelection(); return; }
  runs.forEach(run => {
    const row = document.createElement('div'); row.className = `history-row${state.activeRun?.id === run.id ? ' active' : ''}`;
    const pick = document.createElement('input'); pick.type = 'checkbox'; pick.className = 'history-select'; pick.value = run.id;
    pick.setAttribute('aria-label', `Select run from ${new Date(run.createdAt).toLocaleString()}`);
    pick.addEventListener('change', updateHistorySelection);
    const open = document.createElement('button'); open.type = 'button'; open.className = 'history-open';
    const date = document.createElement('span'); date.textContent = new Date(run.createdAt).toLocaleString();
    const summary = document.createElement('span'); summary.textContent = `${run.summary.generated}/${run.summary.discovered} with schema · ${run.summary.published} published`;
    open.append(date, summary);
    open.addEventListener('click', async () => {
      try {
        window.clearInterval(state.poller);
        const body = await api(`/api/workspaces/runs/${run.id}`); state.activeRun = body.run;
        resetWizard();
        renderRun(); renderHistory(runs);
        if (BUSY.includes(body.run.status)) startPolling();
      } catch (error) { notify(error.message, 'error'); }
    });
    const status = document.createElement('span'); status.className = `status-badge ${run.status}`; status.textContent = RUN_STATUS[run.status] || run.status.replaceAll('_', ' ');
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button history-delete'; remove.innerHTML = TRASH_ICON;
    remove.title = 'Delete this run'; remove.setAttribute('aria-label', `Delete run from ${new Date(run.createdAt).toLocaleString()}`);
    remove.disabled = BUSY.includes(run.status);
    remove.addEventListener('click', () => deleteRuns([run.id]));
    row.append(pick, open, status, remove); container.append(row);
  });
  updateHistorySelection();
}
function updateHistorySelection() {
  const boxes = [...document.querySelectorAll('.history-select')];
  const picked = boxes.filter(box => box.checked).length;
  $('delete-runs').disabled = !picked;
  $('delete-runs').textContent = picked ? `Delete ${picked} selected` : 'Delete selected';
  $('history-select-all').checked = boxes.length > 0 && picked === boxes.length;
  $('history-select-all').indeterminate = picked > 0 && picked < boxes.length;
}
async function deleteRuns(ids) {
  const runs = (state.historyRuns || []).filter(run => ids.includes(run.id));
  if (runs.some(run => BUSY.includes(run.status))) return notify('Wait for the running step to finish before deleting it.', 'info');
  const undoable = runs.reduce((sum, run) => sum + (run.undoable || 0), 0);
  const warning = undoable ? `\n\n${undoable} published page(s) in ${runs.length === 1 ? 'this run' : 'these runs'} stay published, but can no longer be undone from Schematic. Backup files are kept.` : '\n\nPublished schema and backup files are not affected.';
  if (!window.confirm(`Delete ${runs.length === 1 ? 'this run' : `${runs.length} runs`} from the history? This can't be undone.${warning}`)) return;
  try {
    const body = await api(`/api/workspaces/sites/${state.activeSite.id}/runs/delete`, { method: 'POST', body: JSON.stringify({ ids }) });
    if (state.activeRun && ids.includes(state.activeRun.id)) {
      window.clearInterval(state.poller);
      state.activeRun = body.runs[0] ? (await api(`/api/workspaces/runs/${body.runs[0].id}`)).run : null;
      resetWizard(); renderRun();
    }
    renderHistory(body.runs);
    notify(`Deleted ${body.deleted} run${body.deleted === 1 ? '' : 's'}.`, 'success');
  } catch (error) { notify(error.message, 'error'); }
}

function renderProfile(site) {
  const profile = site.profile;
  // The business option in the picker is labelled with this site's business type.
  if (state.schemaTypes.length) renderTypeOptions('type-options', readPlan('type-options', 'type-more').types);
  // Not set up (or missing what Google needs for local results) is a warning, shown in place.
  $('profile-card').classList.toggle('needs-setup', !profile?.name);
  $('profile-card').classList.toggle('has-gaps', Boolean(profile?.name && site.profileGaps?.missing?.length));
  $('edit-profile').className = profile?.name ? 'btn btn-secondary' : 'btn btn-primary';
  $('edit-profile').textContent = profile?.name ? 'Edit profile' : 'Set up profile';
  $('profile-summary').textContent = profile?.name
    ? [profile.name, profile.type, [profile.address?.addressLocality, profile.address?.addressRegion].filter(Boolean).join(', '), profile.telephone].filter(Boolean).join(' · ')
    : 'Not set up yet. Needed for rule-based schema: click Set up profile and it fills itself in from the site.';
  const gaps = site.profileGaps;
  $('profile-gaps').hidden = !gaps;
  if (gaps) {
    const parts = [gaps.missing.length ? `Missing: ${gaps.missing.join(', ')}.` : '', gaps.recommended.length ? `Worth adding: ${gaps.recommended.join(', ')}.` : ''].filter(Boolean);
    $('profile-gaps').textContent = parts.join(' ') || 'Complete.';
    $('profile-gaps').classList.toggle('ok', !parts.length);
  }
}

const PROFILE_FIELDS = { name: 'pf-name', type: 'pf-type', telephone: 'pf-telephone', email: 'pf-email', logo: 'pf-logo', image: 'pf-image', priceRange: 'pf-price', description: 'pf-description' };
const ADDRESS_FIELDS = { streetAddress: 'pf-street', addressLocality: 'pf-city', addressRegion: 'pf-region', postalCode: 'pf-postal', addressCountry: 'pf-country' };
const LIST_FIELDS = { openingHours: 'pf-hours', areaServed: 'pf-areas', sameAs: 'pf-sameas' };
function fillProfile(profile, onlyEmpty) {
  let filled = 0;
  const set = (id, value) => { if (value && (!onlyEmpty || !$(id).value.trim())) { $(id).value = value; filled++; } };
  for (const [key, id] of Object.entries(PROFILE_FIELDS)) set(id, profile[key]);
  for (const [key, id] of Object.entries(ADDRESS_FIELDS)) set(id, profile.address?.[key]);
  for (const [key, id] of Object.entries(LIST_FIELDS)) set(id, (profile[key] || []).join(key === 'areaServed' ? ', ' : '\n'));
  return filled;
}
function readProfile() {
  const profile = Object.fromEntries(Object.entries(PROFILE_FIELDS).map(([key, id]) => [key, $(id).value.trim()]));
  profile.address = Object.fromEntries(Object.entries(ADDRESS_FIELDS).map(([key, id]) => [key, $(id).value.trim()]));
  for (const [key, id] of Object.entries(LIST_FIELDS)) profile[key] = $(id).value.split(key === 'areaServed' ? /[\n,]/ : /\n/).map(item => item.trim()).filter(Boolean);
  return profile;
}
function renderRules(rules) {
  const types = state.meta.buildable;
  $('rules-head').replaceChildren(...['Page kind', ...types].map(text => Object.assign(document.createElement('th'), { textContent: text === 'LocalBusiness' ? businessLabel() : text })));
  $('rules-body').replaceChildren(...Object.entries(state.meta.kinds).map(([kind, info]) => {
    const row = document.createElement('tr');
    row.append(Object.assign(document.createElement('td'), { textContent: info.label }));
    for (const type of types) {
      const cell = document.createElement('td'); const box = document.createElement('input');
      box.type = 'checkbox'; box.dataset.kind = kind; box.value = type; box.checked = (rules?.[kind] || info.types).includes(type);
      // Service-area pages must show opening hours, so they always carry the business.
      if (type === 'LocalBusiness' && state.meta.businessRequired?.includes(kind)) { box.checked = true; box.disabled = true; cell.title = 'Always on: service-area pages need the business opening hours.'; }
      box.setAttribute('aria-label', `${info.label}: ${type === 'LocalBusiness' ? businessLabel() : type}`); cell.append(box); row.append(cell);
    }
    return row;
  }));
}
function readRules() {
  const rules = Object.fromEntries(Object.keys(state.meta.kinds).map(kind => [kind, []]));
  document.querySelectorAll('#rules-body input:checked').forEach(box => rules[box.dataset.kind].push(box.value)); // includes locked boxes
  return rules;
}
async function openProfile() {
  const site = state.activeSite;
  $('profile-form').reset(); $('profile-message').textContent = '';
  if (site.profile) fillProfile(site.profile, false);
  renderRules(site.rules);
  $('profile-dialog').showModal();
  if (!site.profile?.name) await detectProfile(true);
}
async function detectProfile(firstTime) {
  const button = $('detect-profile'); button.disabled = true; $('profile-message').textContent = 'Reading the site…';
  try {
    const body = await api(`/api/workspaces/sites/${state.activeSite.id}/profile/detect`, { method: 'POST', body: '{}' });
    const filled = fillProfile(body.profile, !firstTime);
    $('profile-message').textContent = `${firstTime ? 'Filled in from the site' : `Filled ${filled} empty field(s)`}${body.crawledPages ? ` using ${body.crawledPages} crawled page(s)` : '. Crawl the site for better results'}. Check everything before saving.`;
  } catch (error) { $('profile-message').textContent = error.message; }
  finally { button.disabled = false; }
}
async function saveProfile(event) {
  event.preventDefault();
  try {
    const body = await api(`/api/workspaces/sites/${state.activeSite.id}/profile`, { method: 'PUT', body: JSON.stringify({ profile: readProfile(), rules: readRules() }) });
    state.activeSite = body.site; renderProfile(body.site); $('profile-dialog').close();
    notify('Business profile saved. Generate again to apply it to pages.', 'success');
  } catch (error) { $('profile-message').textContent = error.message; }
}

// Up/down jump buttons; each shows only when there's somewhere to go.
function initScrollNav() {
  const top = $('scroll-top'); const bottom = $('scroll-bottom');
  const smooth = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  const update = () => {
    const room = document.documentElement.scrollHeight - window.innerHeight;
    top.hidden = window.scrollY < 200;
    bottom.hidden = room - window.scrollY < 200;
  };
  top.addEventListener('click', () => window.scrollTo({ top: 0, behavior: smooth }));
  bottom.addEventListener('click', () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth }));
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  // Content grows as runs load and poll; re-check when the page height changes.
  new ResizeObserver(update).observe(document.body);
  update();
}
