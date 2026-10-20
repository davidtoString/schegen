const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function siteDir(site) {
  return path.join(BACKUP_DIR, new URL(site.url).host.replace(/[^\w.-]/g, '_'));
}

function slugFor(url) {
  const slug = new URL(url).pathname.replace(/^\/|\/$/g, '').replace(/[^\w-]+/g, '_');
  return (slug || 'home').slice(0, 80);
}

/**
 * Write one immutable backup file per event, outside the run store, so schema survives
 * run/site deletion and can be restored by hand:
 *   data/backups/<host>/<YYYY-MM-DD>/<time>-<slug>-<kind>.json
 * kinds: original (JSON-LD on the live page when crawled), generated (AI output),
 * published / removed / rolled-back (WordPress stored value before and after).
 */
function save(site, kind, url, payload) {
  try {
    const at = new Date().toISOString();
    const dir = path.join(siteDir(site), at.slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${at.slice(11, 23).replace(/[:.]/g, '')}-${slugFor(url)}-${kind}.json`);
    fs.writeFileSync(file, JSON.stringify({ site: site.url, url, kind, at, ...payload }, null, 2));
    return file;
  } catch (error) {
    // A backup failure must never block the operation it records; it's logged for follow-up.
    console.error(`[backup] ${kind} ${url}: ${error.message}`);
    return null;
  }
}

function list(site) {
  const root = siteDir(site);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort().reverse().flatMap(day => fs.readdirSync(path.join(root, day)).sort().reverse().map(name => path.join(root, day, name)));
}

/**
 * Every backup for a site as one JSON document (newest first), for download.
 */
function bundle(site) {
  return list(site).map(file => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { file: path.basename(file), unreadable: true }; }
  });
}

module.exports = { save, list, bundle };
