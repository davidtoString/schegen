const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const STORE_FILE = path.join(DATA_DIR, 'workspace.json');
const KEY_FILE = path.join(DATA_DIR, '.workspace-key');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadKey() {
  ensureDataDir();
  if (process.env.APP_SECRET) {
    return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  }
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
}

function encrypt(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function decrypt(value) {
  if (!value) return '';
  const [version, iv, tag, payload] = String(value).split(':');
  if (version !== 'v1' || !payload) throw new Error('Stored credential format is invalid');
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8');
}

function emptyStore() {
  return { version: 1, sites: [], runs: [] };
}

function read() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) return emptyStore();
  try {
    return { ...emptyStore(), ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) };
  } catch (error) {
    throw new Error(`Cannot read workspace data: ${error.message}`);
  }
}

function write(data) {
  ensureDataDir();
  const temporary = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, STORE_FILE);
}

function normalizeUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Site URL must use http or https');
  if (parsed.username || parsed.password) throw new Error('Do not put credentials in the site URL');
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function normalizeOrganization(organization = {}) {
  const image = String(organization.image || '').trim();
  if (image) {
    let parsed;
    try { parsed = new URL(image); } catch { throw new Error('Default schema image must be a full https:// URL.'); }
    if (parsed.protocol !== 'https:') throw new Error('Default schema image must be a full https:// URL.');
  }
  return { image };
}

function publicSite(site) {
  const copy = JSON.parse(JSON.stringify(site));
  if (copy.connection) {
    copy.connection.hasAppPassword = Boolean(copy.connection.appPassword);
    delete copy.connection.appPassword;
    delete copy.connection.secretToken;
  }
  return copy;
}

function createSite(input) {
  if (!input.name || !input.url) throw new Error('Site name and URL are required');
  const data = read();
  const now = new Date().toISOString();
  const site = {
    id: crypto.randomUUID(),
    name: String(input.name).trim(),
    url: normalizeUrl(input.url),
    connection: {
      type: 'application-password',
      username: String(input.connection?.username || '').trim(),
      appPassword: encrypt(input.connection?.appPassword)
    },
    organization: normalizeOrganization(input.organization),
    createdAt: now,
    updatedAt: now,
    lastConnectionStatus: 'untested'
  };
  data.sites.push(site);
  write(data);
  return publicSite(site);
}

function updateSite(id, input) {
  const data = read();
  const index = data.sites.findIndex(site => site.id === id);
  if (index < 0) return null;
  const previous = data.sites[index];
  const connection = input.connection || {};
  data.sites[index] = {
    ...previous,
    name: input.name ? String(input.name).trim() : previous.name,
    url: input.url ? normalizeUrl(input.url) : previous.url,
    organization: input.organization === undefined ? previous.organization : normalizeOrganization(input.organization),
    connection: {
      type: 'application-password',
      username: connection.username === undefined ? previous.connection.username : String(connection.username).trim(),
      appPassword: connection.appPassword ? encrypt(connection.appPassword) : previous.connection.appPassword
    },
    updatedAt: new Date().toISOString()
  };
  write(data);
  return publicSite(data.sites[index]);
}

function getSite(id, includeSecrets = false) {
  const site = read().sites.find(item => item.id === id);
  if (!site) return null;
  if (!includeSecrets) return publicSite(site);
  return {
    ...site,
    connection: {
      ...site.connection,
      appPassword: decrypt(site.connection.appPassword)
    }
  };
}

function listSites() {
  return read().sites.map(publicSite);
}

function deleteSite(id) {
  const data = read();
  const before = data.sites.length;
  data.sites = data.sites.filter(site => site.id !== id);
  data.runs = data.runs.filter(run => run.siteId !== id);
  if (data.sites.length === before) return false;
  write(data);
  return true;
}

function updateConnectionStatus(id, status, message) {
  const data = read();
  const site = data.sites.find(item => item.id === id);
  if (!site) return;
  site.lastConnectionStatus = status;
  site.lastConnectionMessage = message;
  site.lastConnectionAt = new Date().toISOString();
  write(data);
}

function createRun(siteId, input = {}) {
  const data = read();
  if (!data.sites.some(site => site.id === siteId)) throw new Error('Site not found');
  const now = new Date().toISOString();
  const run = {
    id: crypto.randomUUID(), siteId, status: 'discovering', source: input.source || 'sitemap',
    sitemapUrl: input.sitemapUrl || '', postTypeFilter: input.postTypeFilter || 'all',
    pages: [], createdAt: now, updatedAt: now, summary: { discovered: 0, generated: 0, failed: 0, published: 0, removed: 0 }
  };
  data.runs.unshift(run);
  write(data);
  return run;
}

function updateRun(id, updater) {
  const data = read();
  const index = data.runs.findIndex(run => run.id === id);
  if (index < 0) return null;
  const changes = typeof updater === 'function' ? updater(data.runs[index]) : updater;
  data.runs[index] = { ...data.runs[index], ...changes, updatedAt: new Date().toISOString() };
  write(data);
  return data.runs[index];
}

function getRun(id) {
  return read().runs.find(run => run.id === id) || null;
}

function listRuns(siteId, limit = 25) {
  return read().runs.filter(run => !siteId || run.siteId === siteId).slice(0, limit);
}

const AI_PROVIDERS = ['openai', 'gemini'];
function aiSettings() {
  const saved = read().aiSettings || {};
  return { defaultProvider: saved.defaultProvider || 'openai', providers: Object.fromEntries(AI_PROVIDERS.map(name => [name, {
    model: saved.providers?.[name]?.model || '',
    models: require('./ai').availableModels[name],
    defaultModel: require('./ai').getDefaultModel(name),
    hasSavedKey: Boolean(saved.providers?.[name]?.apiKey),
    hasEnvironmentKey: Boolean(process.env[`${name.toUpperCase()}_API_KEY`])
  }])) };
}
function saveAISettings(input) {
  if (!input || typeof input !== 'object') throw new Error('Settings are required.');
  if (input.defaultProvider && !AI_PROVIDERS.includes(input.defaultProvider)) throw new Error('Unsupported AI provider.');
  const data = read();
  const saved = data.aiSettings || { providers: {} };
  saved.providers ||= {};
  if (input.defaultProvider) saved.defaultProvider = input.defaultProvider;
  for (const [name, values] of Object.entries(input.providers || {})) {
    if (!AI_PROVIDERS.includes(name) || !values || typeof values !== 'object') throw new Error('Invalid provider settings.');
    const previous = saved.providers[name] || {};
    if (values.model !== undefined && (typeof values.model !== 'string' || values.model.length > 150 || !/^[\w.\/-]*$/.test(values.model))) throw new Error('Invalid model identifier.');
    if (values.apiKey !== undefined && (typeof values.apiKey !== 'string' || values.apiKey.length > 4096 || /\s/.test(values.apiKey.trim()))) throw new Error('Invalid API key.');
    if (values.removeKey && values.apiKey?.trim()) throw new Error('Choose either replace or remove the saved key.');
    saved.providers[name] = { ...previous,
      ...(values.model !== undefined ? { model: values.model } : {}),
      ...(values.removeKey === true ? { apiKey: '' } : values.apiKey?.trim() ? { apiKey: encrypt(values.apiKey.trim()) } : {})
    };
  }
  data.aiSettings = saved; write(data);
  return aiSettings();
}
function resolveAIOptions(options = {}) {
  const saved = read().aiSettings || {};
  const provider = options.provider || saved.defaultProvider || 'openai';
  if (!AI_PROVIDERS.includes(provider)) throw new Error('Unsupported AI provider.');
  const settings = saved.providers?.[provider] || {};
  const apiKey = options.apiKey?.trim() || decrypt(settings.apiKey) || process.env[`${provider.toUpperCase()}_API_KEY`];
  if (!apiKey) throw new Error('Save an API key in AI Settings before generating with AI.');
  return { provider, model: options.model || settings.model || undefined, apiKey };
}

module.exports = {
  aiSettings, saveAISettings, resolveAIOptions,
  createSite, updateSite, getSite, listSites, deleteSite, updateConnectionStatus,
  createRun, updateRun, getRun, listRuns
};

// A stopped process cannot resume an in-memory operation. Preserve results and allow a retry.
const startupData = read();
let recovered = false;
for (const run of startupData.runs) {
  if (['discovering', 'crawling', 'generating', 'publishing'].includes(run.status)) {
    run.status = 'interrupted';
    run.error = 'The server restarted during this operation. Existing results are preserved; retry the unfinished step.';
    recovered = true;
  }
}
if (recovered) write(startupData);
