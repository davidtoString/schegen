/**
 * WordPress REST API Client with RankMath schema integration
 */

const axios = require('axios');

/**
 * Create a WordPress API client
 * @param {string} siteUrl - WordPress site URL
 * @param {string} username - WordPress username
 * @param {string} appPassword - WordPress Application Password
 * @returns {object} - Client methods
 */
function create(siteUrl, username, appPassword, options = {}) {
  const baseUrl = siteUrl.replace(/\/$/, '');
  const apiUrl = `${baseUrl}/wp-json/wp/v2`;
  const postTypes = Array.isArray(options.postTypes) && options.postTypes.length
    ? options.postTypes.map(type => String(type).replace(/^\/+|\/+$/g, ''))
    : ['posts', 'pages'];

  // Create Base64 auth header
  const auth = Buffer.from(`${username}:${appPassword}`).toString('base64');

  const client = axios.create({
    baseURL: apiUrl,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000,
    maxRedirects: 0
  });

  return {
    /**
     * Test the connection to WordPress
     */
    async testConnection() {
      try {
        const response = await client.get('/users/me');
        return {
          success: true,
          user: response.data.name,
          roles: response.data.roles
        };
      } catch (error) {
        throw new Error(`Connection failed: ${error.response?.data?.message || error.message}`);
      }
    },

    /**
     * Find a post or page by its URL
     */
    async findByUrl(pageUrl) {
      try {
        // Extract slug from URL
        const urlObj = new URL(pageUrl);
        if (urlObj.origin !== new URL(baseUrl).origin) throw new Error('Page must belong to the registered site');
        const path = urlObj.pathname.replace(/\/$/, '');
        const slug = path.split('/').pop();
        if (!slug) throw new Error('Use the Workspace Connector to resolve a WordPress homepage');

        for (const endpoint of postTypes) {
          try {
            const response = await client.get(`/${endpoint}`, { params: { slug, per_page: 100, context: 'edit' } });
            const exact = response.data.find(post => post.link && new URL(post.link).href.replace(/\/$/, '') === urlObj.href.replace(/\/$/, ''));
            if (exact) {
              return { type: endpoint.replace(/s$/, ''), endpoint, data: exact };
            }
          } catch (error) {
            if (error.response?.status !== 404) throw error;
          }
        }

        throw new Error('Post/page not found');
      } catch (error) {
        throw new Error(`Find failed: ${error.response?.data?.message || error.message}`);
      }
    },

    /**
     * Get post or page by ID
     */
    async getById(id, type = 'posts') {
      try {
        const response = await client.get(`/${type}/${id}`);
        return response.data;
      } catch (error) {
        throw new Error(`Get failed: ${error.response?.data?.message || error.message}`);
      }
    },

    /**
     * Update post meta (used for RankMath schema)
     */
    async updateMeta(id, type, metaKey, metaValue) {
      try {
        const endpoint = type === 'page' ? 'pages' : (type === 'post' ? 'posts' : type);
        const response = await client.post(`/${endpoint}/${id}`, {
          meta: {
            [metaKey]: metaValue
          }
        });
        return response.data;
      } catch (error) {
        throw new Error(`Meta update failed: ${error.response?.data?.message || error.message}`);
      }
    },

    /**
     * Compatibility entry point. Writes now use the authenticated Workspace Connector.
     */
    async insertMappedSchema(pageUrl, schema, pageType, mapping = {}) {
      return this.insertSchema(pageUrl, schema, pageType);
    },

    async getMappedSnapshot(pageUrl, mapping = {}) {
      const result = await this.findByUrl(pageUrl);
      const prefix = mapping.schemaMetaPrefix || 'rank_math_schema_';
      const richSnippetKey = mapping.richSnippetKey || 'rank_math_rich_snippet';
      const meta = result.data.meta || {};
      const selectedMeta = {};
      for (const [key, value] of Object.entries(meta)) {
        if (key.startsWith(prefix) || key === richSnippetKey || Object.hasOwn(mapping.customFields || {}, key)) {
          selectedMeta[key] = value;
        }
      }
      return {
        postId: result.data.id,
        postType: result.type,
        meta: selectedMeta,
        contentHadWorkspaceSchema: String(result.data.content?.raw || '').includes('Schema Workspace JSON-LD')
      };
    },

    /**
     * Insert through the Workspace Connector with stored and public verification.
     */
    async insertSchema(pageUrl, schema, pageType) {
      const connector = require('./wordpressConnector').create({
        url: baseUrl, connection: { username, appPassword }
      });
      const previous = await connector.snapshot(pageUrl);
      return connector.insert(pageUrl, schema, previous);
    },

    /**
     * Get existing RankMath schemas for a post
     */
    async getExistingSchemas(pageUrl) {
      const result = await this.findByUrl(pageUrl);
      const { data } = result;

      const schemas = [];
      const meta = data.meta || {};

      // Look for RankMath schema meta keys
      for (const [key, value] of Object.entries(meta)) {
        if (key.startsWith('rank_math_schema_')) {
          try {
            schemas.push({
              type: key.replace('rank_math_schema_', ''),
              schema: typeof value === 'string' ? JSON.parse(value) : value
            });
          } catch {
            // Invalid JSON, skip
          }
        }
      }

      return schemas;
    },

    /**
     * Batch update multiple posts with schemas
     */
    async batchInsert(items) {
      const results = [];

      for (const item of items) {
        try {
          const result = await this.insertSchema(item.url, item.schema, item.pageType);
          results.push({ url: item.url, success: true, ...result });
        } catch (error) {
          results.push({ url: item.url, success: false, error: error.message });
        }
      }

      return results;
    }
  };
}

/**
 * Validate WordPress credentials format
 */
function validateCredentials(username, appPassword) {
  const errors = [];

  if (!username || username.trim().length === 0) {
    errors.push('Username is required');
  }

  if (!appPassword || appPassword.trim().length === 0) {
    errors.push('Application Password is required');
  }

  // Application passwords are typically formatted with spaces
  // e.g., "abcd efgh ijkl mnop qrst uvwx"
  if (appPassword && !appPassword.includes(' ') && appPassword.length !== 24) {
    errors.push('Application Password format appears invalid');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  create,
  validateCredentials
};
