const axios = require('axios');
const cheerio = require('cheerio');
const { isDeepStrictEqual } = require('node:util');

function create(site) {
  const base = new URL(site.url);
  if (base.username || base.password) throw new Error('Use the credential fields, not credentials in the site URL.');
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
    throw new Error('WordPress Application Passwords require HTTPS.');
  }
  const http = axios.create({
    baseURL: `${site.url.replace(/\/$/, '')}/wp-json/`, timeout: 30000, maxRedirects: 0,
    maxContentLength: 5 * 1024 * 1024,
    auth: { username: site.connection.username, password: site.connection.appPassword }
  });
  function checkUrl(url) {
    const target = new URL(url);
    if (target.origin !== base.origin || target.username || target.password) throw new Error('Page must belong to the registered site.');
  }
  const client = {
    async testConnection() {
      try { return (await http.get('schema-workspace/v1/status')).data; }
      catch (error) { throw new Error(`WordPress connector unavailable: ${error.response?.data?.message || error.message}. Install and activate Schema Workspace Connector and check the Application Password.`); }
    },
    async discover(limit = 100, filter = 'all') {
      const types = (await http.get('wp/v2/types')).data;
      const pages = [];
      for (const [name, type] of Object.entries(types)) {
        if (name === 'attachment' || name === 'nav_menu_item' || name.startsWith('wp_') || (filter === 'pages' && name !== 'page') || (filter === 'posts' && name !== 'post')) continue;
        const namespace = type.rest_namespace || 'wp/v2';
        if (!/^[\w/-]+$/.test(namespace) || !/^[\w-]+$/.test(type.rest_base || '')) continue;
        for (let page = 1; pages.length < limit; page++) {
          const response = await http.get(`${namespace}/${type.rest_base}`, { params: { status: 'publish', per_page: 100, page, orderby: 'id', order: 'asc', _fields: 'id,link,type' } });
          for (const post of response.data) {
            if (pages.length >= limit) break;
            if (post.link) { checkUrl(post.link); pages.push({ url: post.link, postId: post.id, postType: post.type || name, endpoint: `${namespace}/${type.rest_base}` }); }
          }
          if (!response.data.length || page >= Number(response.headers['x-wp-totalpages'] || 1)) break;
        }
        if (pages.length >= limit) break;
      }
      return pages;
    },
    async snapshot(url) {
      checkUrl(url);
      return (await http.get('schema-workspace/v1/schema', { params: { url } })).data;
    },
    async inspectPublic(url) {
      checkUrl(url);
      const response = await axios.get(url, { timeout: 30000, maxRedirects: 0, maxContentLength: 5 * 1024 * 1024 });
      const $ = cheerio.load(response.data);
      return $('script[type="application/ld+json"]').toArray().map(element => {
        try { return JSON.parse($(element).text()); } catch { return { invalidJSONLD: true }; }
      });
    },
    async restore(url, before, after) {
      const current = await this.snapshot(url);
      if (!isDeepStrictEqual(current, after)) throw new Error('Rollback blocked: WordPress changed after this insertion.');
      await http.post('schema-workspace/v1/restore', { url, schema: before.schema, expected: after.schema, expectedSuppression: Boolean(after.suppressesRankMath), suppressRankMath: Boolean(before.suppressesRankMath) });
      const restored = await this.snapshot(url);
      if (!isDeepStrictEqual(restored, before)) throw new Error('Rollback read-back did not match the backup.');
      return { restored: true };
    },
    async insert(url, schema, previous, options = {}) {
      checkUrl(url);
      const suppressRankMath = options.suppressRankMath ?? Boolean(previous.suppressesRankMath);
      const result = (await http.post('schema-workspace/v1/schema', { url, schema, expected: previous.schema, expectedSuppression: Boolean(previous.suppressesRankMath), suppressRankMath, removeExisting: schema === null })).data;
      if (result.success !== true) throw new Error('WordPress did not confirm insertion.');
      const stored = await this.snapshot(url);
      if (!isDeepStrictEqual(stored.schema, schema)) throw new Error('WordPress read-back differs from the generated schema.');
      if (stored.schemaControl && stored.suppressesRankMath !== suppressRankMath) throw new Error('WordPress did not save the requested Rank Math output policy.');
      if (schema === null) {
        let verified = false;
        try { verified = (await this.inspectPublic(url)).length === 0; } catch { /* Stored removal still needs a public check. */ }
        return { success: true, stored: true, removed: true, verified, verificationMessage: verified ? 'Schema removed from this public page. Rank Math settings are preserved for undo.' : 'Removal saved. Public schema remains or could not be checked; review caches and other plugins.' };
      }
      return { success: true, stored: true, postId: stored.postId, ...(await this.verify(url, schema)) };
    },
    async verify(url, schema) {
      checkUrl(url);
      try {
        // Public request deliberately has no credentials. Check what visitors and crawlers actually receive.
        const response = await axios.get(url, { timeout: 30000, maxRedirects: 0, maxContentLength: 5 * 1024 * 1024 });
        const $ = cheerio.load(response.data);
        const selector = 'script[type="application/ld+json"]';
        const verified = $(selector).toArray().some(element => {
          try {
            const actual = JSON.parse($(element).text());
            if (isDeepStrictEqual(actual, schema)) return true;
            return actual?.['@context'] === schema['@context'] && Array.isArray(actual['@graph']) && schema['@graph']?.length > 0 && schema['@graph'].every(node => actual['@graph'].some(candidate => isDeepStrictEqual(candidate, node)));
          }
          catch { return false; }
        });
        return { verified, verificationMessage: verified ? 'JSON-LD verified on the public page.' : 'Saved in WordPress, but public JSON-LD does not match yet. Purge the page/CDN cache and verify again.' };
      } catch (error) {
        return { verified: false, verificationMessage: `Saved; public verification failed: ${error.message}` };
      }
    }
  };
  if (site.mapping?.integration === 'rest-meta') return require('./wordpressRestMeta').create(site, http, client);
  return client;
}
module.exports = { create };
