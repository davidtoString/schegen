const express = require('express');
const path = require('path');
const store = require('../services/workspaceStore');
const connector = require('../services/wordpressConnector');
const sitemap = require('../services/sitemapParser');
const scraper = require('../services/pageScraper');
const schemas = require('../services/pageSchema');
const decisions = require('../services/schemaDecision');
const { isDeepStrictEqual: equal } = require('node:util');
const router = express.Router();
const busySites = new Set();
const MAX_PAGES = Math.min(1000, Math.max(1, Number(process.env.MAX_CRAWL_PAGES) || 100));
const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function siteFor(id) { return store.getSite(id, true) || fail('Site not found', 404); }
function runFor(id) { return store.getRun(id) || fail('Run not found', 404); }
function clientFor(site) {
  if (site.connection.type !== 'application-password') fail('Choose WordPress Application Password. Legacy helper access remains in the advanced generator.');
  return connector.create(site);
}
function lock(id) { if (busySites.has(id)) fail('This site already has an operation running.', 409); busySites.add(id); }
function summary(pages) { return {
  discovered: pages.length, crawled: pages.filter(p => p.pageData).length,
  generated: pages.filter(p => p.schema && p.validation?.valid).length,
  failed: pages.filter(p => ['failed', 'invalid', 'publish_failed'].includes(p.status)).length,
  published: pages.filter(p => p.status === 'published').length
}; }
function updatePage(id, url, values) {
  return store.updateRun(id, run => {
    const pages = run.pages.map(p => p.url === url ? {
      ...p, ...values,
      ...(values.publishAttemptAt ? { insertionHistory: [...(p.insertionHistory || []), { at: values.publishAttemptAt, previousState: values.previousState }] } : {})
    } : p);
    return { pages, summary: summary(pages) };
  });
}
function select(run, urls) {
  if (!Array.isArray(urls) || !urls.length) fail('Select at least one page.');
  const chosen = [...new Set(urls)];
  if (chosen.some(url => !run.pages.some(p => p.url === url))) fail('Selection contains a page outside this run.');
  return run.pages.filter(p => chosen.includes(p.url));
}
router.get('/connector', (req, res) => res.download(path.join(__dirname, '../../wordpress/schema-workspace.zip')));
router.get('/settings/ai', (req, res) => res.set('Cache-Control', 'no-store').json({ success: true, settings: store.aiSettings() }));
router.put('/settings/ai', route(async (req, res) => {
  try { res.set('Cache-Control', 'no-store').json({ success: true, settings: store.saveAISettings(req.body) }); }
  catch (error) { fail(error.message); }
}));
router.get('/sites', (req, res) => res.json({ success: true, sites: store.listSites() }));
router.post('/sites', route(async (req, res) => res.status(201).json({ success: true, site: store.createSite(req.body) })));
router.get('/sites/:id', route(async (req, res) => {
  siteFor(req.params.id);
  res.json({ success: true, site: store.getSite(req.params.id), runs: store.listRuns(req.params.id) });
}));
router.put('/sites/:id', route(async (req, res) => {
  siteFor(req.params.id);
  if (busySites.has(req.params.id)) fail('Wait for the operation to finish before changing settings.', 409);
  res.json({ success: true, site: store.updateSite(req.params.id, req.body) });
}));
router.delete('/sites/:id', route(async (req, res) => {
  if (busySites.has(req.params.id)) fail('Wait for the operation to finish before deleting.', 409);
  if (!store.deleteSite(req.params.id)) fail('Site not found', 404);
  res.json({ success: true });
}));
router.post('/sites/:id/test', route(async (req, res) => {
  const site = siteFor(req.params.id);
  try {
    const result = await clientFor(site).testConnection();
    store.updateConnectionStatus(site.id, 'connected', `Connected as ${result.user}. ${result.message || ''}`);
    res.json({ success: true, result });
  } catch (error) { store.updateConnectionStatus(site.id, 'failed', error.message); throw error; }
}));
router.post('/sites/:id/crawls', route(async (req, res) => {
  const site = siteFor(req.params.id);
  if (req.body.urls !== undefined && !Array.isArray(req.body.urls)) fail('URLs must be an array.');
  lock(site.id);
  let run;
  try { run = store.createRun(site.id, req.body); }
  catch (error) { busySites.delete(site.id); throw error; }
  setImmediate(() => crawl(run.id, site, req.body));
  res.status(202).json({ success: true, run });
}));
async function crawl(id, site, options) {
  try {
    let pages = [];
    let source = 'manual';
    if (options.urls?.length) pages = options.urls.map(url => ({ url }));
    else if (options.sitemapUrl) {
      if (new URL(options.sitemapUrl).origin !== new URL(site.url).origin) fail('Sitemap must belong to this site.');
      pages = (await sitemap.parse(options.sitemapUrl, options.postTypeFilter)).map(url => ({ url })); source = 'sitemap';
    } else {
      source = 'wordpress';
      try { pages = await clientFor(site).discover(MAX_PAGES + 1, options.postTypeFilter); }
      catch (error) {
        source = 'sitemap';
        store.updateRun(id, { discoveryWarning: `WordPress discovery unavailable: ${error.message}. Trying sitemap.` });
        pages = (await sitemap.parse(await sitemap.findSitemap(site.url), options.postTypeFilter)).map(url => ({ url }));
      }
    }
    const seen = new Set();
    pages = pages.filter(page => {
      try {
        const url = new URL(page.url, site.url); url.hash = '';
        if (url.origin !== new URL(site.url).origin || url.username || url.password) return false;
        page.url = url.href;
        if (seen.has(page.url)) return false;
        seen.add(page.url); return true;
      } catch { return false; }
    });
    const limited = pages.length > MAX_PAGES;
    pages = pages.slice(0, MAX_PAGES).map(p => ({ ...p, status: 'queued' }));
    if (!pages.length) fail('No public pages found. Supply page URLs or a WordPress sitemap.');
    store.updateRun(id, { status: 'crawling', source, limited, pages, summary: summary(pages) });
    for (const page of pages) {
      try {
        const pageData = await scraper.scrape(page.url);
        pageData.content = pageData.content || pageData.textContent || '';
        if (page.postType) pageData.wordpressInfo = { ...pageData.wordpressInfo, postType: page.postType };
        if (!pageData.title || !pageData.content) fail('No readable page content was found.');
        updatePage(id, page.url, { status: 'crawled', title: pageData.title, pageData, crawledAt: new Date().toISOString() });
      } catch (error) { updatePage(id, page.url, { status: 'failed', error: error.message }); }
    }
    store.updateRun(id, { status: 'ready' });
  } catch (error) { store.updateRun(id, { status: 'failed', error: error.message }); }
  finally { busySites.delete(site.id); }
}
router.get('/runs', (req, res) => res.json({ success: true, runs: store.listRuns(req.query.siteId) }));
router.get('/runs/:id', route(async (req, res) => res.json({ success: true, run: runFor(req.params.id) })));
router.post('/runs/:id/generate', route(async (req, res) => {
  const run = runFor(req.params.id);
  const pages = select(run, req.body.urls);
  if (pages.some(p => !p.pageData)) fail('Crawl selected pages successfully before generating schema.');
  let aiOptions;
  try { aiOptions = store.resolveAIOptions(req.body); } catch (error) { fail(error.message); }
  lock(run.siteId);
  store.updateRun(run.id, { status: 'generating', error: null });
  setImmediate(async () => {
    try {
      for (const page of pages) {
        updatePage(run.id, page.url, { schema: null, validation: null, existingReview: null, error: null, status: 'generating' });
        try {
          const schema = await schemas.generateAI(page.pageData, aiOptions);
          const validation = schemas.validate(schema, page.pageData);
          updatePage(run.id, page.url, { schema, validation, generation: { engine: 'ai', provider: aiOptions.provider, model: aiOptions.model || require('../services/ai').getDefaultModel(aiOptions.provider) }, status: validation.valid ? 'generated' : 'invalid', schemaTypes: schema['@graph']?.flatMap(n => n['@type']) || [], generatedAt: new Date().toISOString() });
        } catch (error) { updatePage(run.id, page.url, { status: 'failed', error: aiOptions?.apiKey ? error.message.split(aiOptions.apiKey).join('[redacted]') : error.message }); }
      }
      store.updateRun(run.id, { status: 'completed' });
    } catch (error) { store.updateRun(run.id, { status: 'failed', error: error.message }); }
    finally { busySites.delete(run.siteId); }
  });
  res.status(202).json({ success: true, runId: run.id });
}));
router.post('/runs/:id/publish', route(async (req, res) => {
  const run = runFor(req.params.id);
  const pages = select(run, req.body.urls);
  const removing = req.body.schemaPolicy === 'remove-existing';
  if (!removing && pages.some(p => !p.schema || !p.pageData || !schemas.validate(p.schema, p.pageData).valid)) fail('Every selected page needs valid generated schema.');
  const site = siteFor(run.siteId);
  const client = clientFor(site);
  const dryRun = req.body.dryRun !== false;
  lock(site.id);
  const results = [];
  try {
    store.updateRun(run.id, { status: 'publishing' });
    for (const page of pages) {
      try {
        const previous = await client.snapshot(page.url);
        const existing = await client.inspectPublic(page.url);
        const owned = !previous.metaKey || store.listRuns(site.id, Number.MAX_SAFE_INTEGER).some(item => item.pages.some(p =>
          p.url === page.url && p.writeReceipt?.siteUrl === site.url && !p.writeReceipt.rolledBack && equal(p.writeReceipt.after, previous)));
        const proposed = removing ? null : page.schema;
        const review = decisions.assess(previous, existing, proposed, req.body.schemaPolicy || 'keep', owned);
        if (dryRun) {
          updatePage(run.id, page.url, { existingReview: review });
        } else {
          if (!page.existingReview || !equal(page.existingReview, review)) throw new Error('Preview again: the schema, policy, mapping or live page changed since review.');
          if (review.blocked) throw new Error(review.blocked);
          if (review.requiresAcknowledgement && req.body.acknowledgeConflicts !== true) throw new Error('Review the before/after and acknowledge the selected existing-schema action.');
        }
        if (review.skip) {
          const result = { success: true, skipped: true, dryRun, verificationMessage: 'Kept existing schema. No WordPress changes.' };
          results.push({ url: page.url, ...result });
          updatePage(run.id, page.url, { preview: result, decisionMessage: result.verificationMessage });
          continue;
        }
        if (dryRun && review.blocked) {
          results.push({ url: page.url, success: false, error: review.blocked });
          updatePage(run.id, page.url, { publishError: review.blocked });
          continue;
        }
        // Persist before the external write, including attempts that fail or are interrupted.
        updatePage(run.id, page.url, { previousState: previous, publishError: null, publishAttemptAt: new Date().toISOString() });
        const result = dryRun ? { success: true, dryRun: true, postId: previous.postId, metaKey: previous.metaKey, verificationMessage: `Preview ready for ${review.decision}. Open Review to compare changes. No write performed.` } : await client.insert(page.url, proposed, previous, { suppressRankMath: review.suppressRankMath || (review.decision === 'replace-managed' && Boolean(previous.suppressesRankMath)) });
        if (!dryRun && result.stored) {
          const after = await client.snapshot(page.url);
          updatePage(run.id, page.url, { receiptHistory: [...(page.receiptHistory || []), ...(page.writeReceipt ? [page.writeReceipt] : [])], writeReceipt: { siteUrl: site.url, before: previous, after, publicBefore: existing, at: new Date().toISOString(), rolledBack: false }, decisionMessage: null });
        }
        results.push({ url: page.url, ...result });
        updatePage(run.id, page.url, dryRun ? { preview: result } : { status: result.removed ? 'schema_removed' : result.verified ? 'published' : 'verification_pending', publishResult: result, publishedAt: new Date().toISOString() });
      } catch (error) {
        results.push({ url: page.url, success: false, error: error.message });
        updatePage(run.id, page.url, { publishError: error.message, ...(dryRun ? {} : { status: 'publish_failed' }) });
      }
    }
    store.updateRun(run.id, { status: results.every(r => r.success) ? 'completed' : 'completed_with_errors', lastPublish: { dryRun, results, at: new Date().toISOString() } });
    res.json({ success: results.every(r => r.success), dryRun, results });
  } finally { busySites.delete(site.id); }
}));
router.post('/runs/:id/rollback', route(async (req, res) => {
  const run = runFor(req.params.id);
  const pages = select(run, req.body.urls);
  const site = siteFor(run.siteId);
  if (pages.some(page => !page.writeReceipt || page.writeReceipt.rolledBack || page.writeReceipt.siteUrl !== site.url)) fail('Selected pages need an unreverted app insertion for this site.');
  const client = clientFor(site);
  lock(site.id);
  const results = [];
  try {
    for (const page of pages) {
      const at = new Date().toISOString();
      try {
        updatePage(run.id, page.url, { rollbackAttemptAt: at });
        await client.restore(page.url, page.writeReceipt.before, page.writeReceipt.after);
        let publicVerified = false;
        try { publicVerified = equal(await client.inspectPublic(page.url), page.writeReceipt.publicBefore); } catch { /* Storage restoration succeeded, public verification is separate. */ }
        const result = { url: page.url, restored: true, publicVerified, at };
        results.push(result);
        updatePage(run.id, page.url, { status: 'rolled_back', existingReview: null, writeReceipt: { ...page.writeReceipt, rolledBack: true }, rollbackHistory: [...(page.rollbackHistory || []), result], publishResult: { verificationMessage: publicVerified ? 'Previous schema restored and public output verified.' : 'Previous stored value restored. Public output differs; clear caches and inspect the page.' }, publishError: null });
      } catch (error) {
        const result = { url: page.url, restored: false, error: error.message, at };
        results.push(result);
        updatePage(run.id, page.url, { publishError: error.message, rollbackHistory: [...(page.rollbackHistory || []), result] });
      }
    }
    res.json({ success: results.every(result => result.restored), results, run: runFor(run.id) });
  } finally { busySites.delete(site.id); }
}));
router.post('/runs/:id/verify', route(async (req, res) => {
  const run = runFor(req.params.id);
  const pages = select(run, req.body.urls);
  if (pages.some(p => !p.schema && p.status !== 'schema_removed')) fail('Selected pages need generated schema or a saved removal.');
  const client = clientFor(siteFor(run.siteId));
  lock(run.siteId);
  try {
    for (const page of pages) {
      const removal = page.status === 'schema_removed';
      const result = removal ? { verified: (await client.inspectPublic(page.url)).length === 0, verificationMessage: 'Removal checked against the current public page; any remaining markup requires cache/plugin review.' } : await client.verify(page.url, page.schema);
      updatePage(run.id, page.url, { status: removal ? 'schema_removed' : result.verified ? 'published' : 'verification_pending', publishResult: { ...page.publishResult, ...result } });
    }
    res.json({ success: true, run: runFor(run.id) });
  } finally { busySites.delete(run.siteId); }
}));
router.use((error, req, res, next) => res.status(error.status || 502).json({ success: false, error: error.message }));
module.exports = router;
