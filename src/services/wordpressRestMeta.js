const { isDeepStrictEqual } = require('node:util');

// Core REST metadata only: never guess vendor serialization or write post content.
function create(site, http, common) {
  let inventory;
  const canonical = value => {
    const url = new URL(value);
    if (url.origin !== new URL(site.url).origin || url.username || url.password) throw new Error('Page must belong to the registered site.');
    url.hash = '';
    url.pathname = url.pathname.replace(/\/$/, '') || '/';
    return url.href;
  };
  async function target(url) {
    const wanted = canonical(url);
    inventory ||= await common.discover(10001);
    if (inventory.length > 10000) throw new Error('Direct REST target discovery exceeds 10,000 items. Use the connector for this site.');
    const matches = inventory.filter(item => canonical(item.url) === wanted);
    if (matches.length !== 1) throw new Error('URL must match exactly one published REST post/page/custom-type item. Archives and unexposed post types are unsupported.');
    return matches[0];
  }
  function mappingFor(type) {
    const override = site.mapping.restOverrides?.[type] || {};
    const key = override.key || site.mapping.restMetaKey;
    const encoding = override.encoding || site.mapping.restEncoding || 'json-string';
    if (!key || typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Configure the exact registered REST metadata key for this post type.');
    if (!['json-string', 'object'].includes(encoding)) throw new Error('Metadata encoding must be json-string or object.');
    return { key, encoding };
  }
  const client = {
    ...common,
    async testConnection() {
      const user = (await http.get('wp/v2/users/me', { params: { context: 'edit' } })).data;
      if (!user.id) throw new Error('WordPress did not authenticate the Application Password.');
      return { user: user.name || user.slug || user.id, integration: 'rest-meta', message: 'Authenticated. Preview publish checks each mapped field; public verification checks rendering.' };
    },
    async snapshot(url) {
      const item = await target(url);
      const { key, encoding } = mappingFor(item.postType);
      const endpoint = `${item.endpoint}/${item.postId}`;
      const options = (await http.options(endpoint)).data;
      const definition = options.schema?.properties?.meta?.properties?.[key];
      if (!definition || definition.readonly === true || options.schema.properties.meta.readonly === true) throw new Error(`Metadata "${key}" is not exposed as writable in the REST schema for ${item.postType}. Register it with show_in_rest or use the connector.`);
      const expectedType = encoding === 'object' ? 'object' : 'string';
      if (!(Array.isArray(definition.type) ? definition.type : [definition.type]).includes(expectedType)) throw new Error(`Metadata "${key}" must have REST type ${expectedType}; check its encoding setting.`);
      const post = (await http.get(endpoint, { params: { context: 'edit' } })).data;
      if (canonical(post.link) !== canonical(url) || post.status !== 'publish' || post.password) throw new Error('Target is not the expected public, unprotected WordPress page.');
      if (!post.meta || !Object.hasOwn(post.meta, key)) throw new Error(`Metadata "${key}" is unavailable in edit context. Check field registration and user permissions.`);
      return { postId: item.postId, postType: item.postType, url: post.link, endpoint, metaKey: key, encoding, rawValue: post.meta[key] };
    },
    async insert(url, schema, previous) {
      const current = await client.snapshot(url);
      if (!isDeepStrictEqual(current, previous)) throw new Error('WordPress metadata or its mapping changed since preview. Retry after reviewing the new state.');
      const value = current.encoding === 'object' ? schema : JSON.stringify(schema);
      await http.post(current.endpoint, { meta: { [current.metaKey]: value } });
      const stored = await client.snapshot(url);
      if (!isDeepStrictEqual(stored.rawValue, value)) throw new Error('WordPress read-back differs from the requested metadata. The write may have been filtered or ignored.');
      return { success: true, stored: true, postId: stored.postId, metaKey: stored.metaKey, ...(await client.verify(url, schema)) };
    },
    async restore(url, before, after) {
      const current = await client.snapshot(url);
      if (!isDeepStrictEqual(current, after)) throw new Error('Rollback blocked: WordPress or the field mapping changed after insertion.');
      await http.post(current.endpoint, { meta: { [current.metaKey]: before.rawValue } });
      if (!isDeepStrictEqual(await client.snapshot(url), before)) throw new Error('Rollback read-back did not match the backup.');
      return { restored: true };
    }
  };
  return client;
}
module.exports = { create };
