const express = require('express');
const path = require('path');
const store = require('../services/workspaceStore');
const connector = require('../services/wordpressConnector');
const sitemap = require('../services/sitemapParser');
const scraper = require('../services/pageScraper');
const schemas = require('../services/pageSchema');
const decisions = require('../services/schemaDecision');
const backups = require('../services/backupStore');
const profiles = require('../services/businessProfile');
const builder = require('../services/schemaBuilder');
const { isDeepStrictEqual: equal } = require('node:util');
const router = express.Router();
const busySites = new Set();
const MAX_PAGES = Math.min(1000, Math.max(1, Number(process.env.MAX_CRAWL_PAGES) || 100));
const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function siteFor(id) { return store.getSite(id, true) || fail('Site not found', 404); }
function runFor(id) { return store.getRun(id) || fail('Run not found', 404); }
function clientFor(site) {
  if (site.connection.type !== 'application-password') fail('This site was registered with an unsupported connection type. Edit its settings and reconnect with a WordPress Application Password.');
  return connector.create(site);
}
function schemaPolicyKind(proposed) { return proposed === null ? 'removed' : 'published'; }
// What the browser needs per page for the table; full crawled data loads on Review (GET /runs/:id/page).
function runView(run) {
  if (!run) return run;
  const siteUrl = store.getSite(run.siteId)?.url;
  return { ...run, pages: run.pages.map(({ pageData, ...page }) => ({ ...page, kind: siteUrl ? builder.classify({ ...page, pageData }, siteUrl) : undefined, ...(pageData ? { pageData: {
    canonical: pageData.canonical, fetchedVia: pageData.fetchedVia, fetchWarning: pageData.fetchWarning, existingSchemaCount: pageData.existingSchema?.length || 0
  } } : {}) })) };
}
function siteView(site) { return site && { ...site, rules: builder.rulesFor(site.rules), profileGaps: site.profile ? profiles.gaps(site.profile) : null }; }
function lock(id) { if (busySites.has(id)) fail('This site already has an operation running.', 409); busySites.add(id); }
function summary(pages) { return {
  discovered: pages.length, crawled: pages.filter(p => p.pageData).length,
  generated: pages.filter(p => p.schema && p.validation?.valid).length,
  failed: pages.filter(p => ['failed', 'invalid', 'publish_failed'].includes(p.status)).length,
  published: pages.filter(p => p.status === 'published').length,
  removed: pages.filter(p => p.status === 'schema_removed').length
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
  const runs = store.listRunSummaries(req.params.id);
  // ?run=<id|latest> also returns that one run in full, so selecting a site is a single request.
  const wanted = req.query.run === 'latest' ? runs[0]?.id : runs.some(run => run.id === req.query.run) ? req.query.run : req.query.run ? runs[0]?.id : null;
  res.json({ success: true, site: siteView(store.getSite(req.params.id)), runs, ...(wanted ? { run: runView(store.getRun(wanted)) } : {}) });
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
function optionalClient(site) { try { return clientFor(site); } catch { return null; } }
/**
 * Find pages, falling through every source rather than failing: manual URLs → given sitemap →
 * WordPress API → discovered sitemap (robots.txt / common paths) → homepage links → homepage.
 */
async function discover(site, options, warnings) {
  if (options.urls?.length) return { source: 'manual', pages: options.urls.map(url => ({ url })) };
  const attempts = [];
  if (options.sitemapUrl) attempts.push(['sitemap', async () => {
    if (!sitemap.sameSite(options.sitemapUrl, site.url)) fail('Sitemap must belong to this site.');
    return sitemapPages(options.sitemapUrl, options.postTypeFilter, warnings);
  }]);
  attempts.push(
    ['wordpress', async () => clientFor(site).discover(MAX_PAGES + 1, options.postTypeFilter)],
    ['sitemap', async () => sitemapPages(await sitemap.findSitemap(site.url), options.postTypeFilter, warnings)],
    ['links', async () => [site.url, ...scraper.extractLinks(await scraper.fetchHtml(site.url), site.url)].map(url => ({ url }))]
  );
  for (const [source, attempt] of attempts) {
    try {
      const pages = await attempt();
      if (pages.length) return { source, pages };
      warnings.push(`${source}: no pages found.`);
    } catch (error) { warnings.push(`${source}: ${error.message}`); }
  }
  warnings.push('Every discovery method failed; crawling the homepage only. Add page URLs manually for more.');
  return { source: 'homepage', pages: [{ url: site.url }] };
}
async function sitemapPages(url, filter, warnings) {
  const context = { visited: new Set(), depth: 0, maxDepth: 6, maxUrls: 5000, origin: new URL(url).origin, warnings: [] };
  const urls = await sitemap.parse(url, filter, context);
  warnings.push(...context.warnings.map(message => `sitemap: ${message}`));
  return urls.map(item => ({ url: item }));
}
/**
 * Fetch each page publicly; if the site blocks or errors, rebuild it from the WordPress API.
 * A page only fails when both routes fail, and it can be retried on its own later.
 */
async function crawlPages(id, site, pages) {
  const client = optionalClient(site);
  for (const page of pages) {
    updatePage(id, page.url, { status: 'crawling', error: null });
    let pageData; let publicError;
    try {
      pageData = scraper.parse(await scraper.fetchHtml(page.url), page.url);
      pageData.content = pageData.content || pageData.textContent || '';
      if (!pageData.title || !pageData.content) throw new Error('No readable page content was found.');
      pageData.fetchedVia = 'public';
    } catch (error) {
      publicError = error.response ? `HTTP ${error.response.status}` : error.message;
      pageData = null;
    }
    if (!pageData && client) {
      try {
        pageData = scraper.parse(await client.fetchContent(page), page.url);
        pageData.content = pageData.content || pageData.textContent || '';
        if (!pageData.title || !pageData.content) throw new Error('WordPress returned no readable content.');
        pageData.fetchedVia = 'wordpress-api';
        pageData.fetchWarning = `Public page unavailable (${publicError}); content read through the WordPress API.`;
      } catch (error) { publicError += `; WordPress API: ${error.message}`; pageData = null; }
    }
    if (!pageData) { updatePage(id, page.url, { status: 'failed', error: `Could not read page: ${publicError}` }); continue; }
    if (page.postType) pageData.wordpressInfo = { ...pageData.wordpressInfo, postType: page.postType };
    if (pageData.existingSchema?.length) backups.save(site, 'original', page.url, { schema: pageData.existingSchema, fetchedVia: pageData.fetchedVia });
    updatePage(id, page.url, { status: 'crawled', title: pageData.title, pageData, error: null, crawledAt: new Date().toISOString() });
  }
}
async function crawl(id, site, options) {
  try {
    const warnings = [];
    let { pages, source } = await discover(site, options, warnings);
    if (warnings.length) store.updateRun(id, { discoveryWarning: warnings.join(' ') });
    const seen = new Set();
    pages = pages.filter(page => {
      try {
        const url = new URL(page.url, site.url); url.hash = '';
        if (!sitemap.sameSite(url.href, site.url) || url.username || url.password) return false;
        page.url = url.href;
        if (seen.has(page.url)) return false;
        seen.add(page.url); return true;
      } catch { return false; }
    });
    const limited = pages.length > MAX_PAGES;
    pages = pages.slice(0, MAX_PAGES).map(p => ({ ...p, status: 'queued' }));
    if (!pages.length) fail('No pages on this site were found. Supply page URLs manually.');
    store.updateRun(id, { status: 'crawling', source, limited, pages, summary: summary(pages) });
    // Schema removal only needs page URLs, not scraped content — skip the fetch/parse pass entirely.
    if (!options.skipContent) await crawlPages(id, site, pages);
    store.updateRun(id, { status: 'ready' });
  } catch (error) { store.updateRun(id, { status: 'failed', error: error.message }); }
  finally { busySites.delete(site.id); }
}
router.post('/runs/:id/recrawl', route(async (req, res) => {
  const run = runFor(req.params.id);
  const pages = select(run, req.body.urls);
  const site = siteFor(run.siteId);
  lock(site.id);
  store.updateRun(run.id, { status: 'crawling', error: null });
  setImmediate(async () => {
    try { await crawlPages(run.id, site, pages); store.updateRun(run.id, { status: 'ready' }); }
    catch (error) { store.updateRun(run.id, { status: 'failed', error: error.message }); }
    finally { busySites.delete(site.id); }
  });
  res.status(202).json({ success: true, runId: run.id });
}));
router.get('/runs', (req, res) => res.json({ success: true, runs: store.listRunSummaries(req.query.siteId) }));
router.get('/runs/:id', route(async (req, res) => res.json({ success: true, run: runView(runFor(req.params.id)) })));
router.get('/runs/:id/page', route(async (req, res) => {
  const page = runFor(req.params.id).pages.find(item => item.url === req.query.url) || fail('Page not found in this run.', 404);
  res.json({ success: true, page });
}));
router.post('/runs/:id/generate', route(async (req, res) => {
  const run = runFor(req.params.id);
  const pages = select(run, req.body.urls);
  if (pages.some(p => !p.pageData)) fail('Crawl selected pages successfully before generating schema.');
  const engine = req.body.engine === 'ai' ? 'ai' : 'rules';
  const site = siteFor(run.siteId);
  let aiOptions;
  if (engine === 'ai') { try { aiOptions = store.resolveAIOptions(req.body); } catch (error) { fail(error.message); } }
  else if (!site.profile?.name) fail('Set up the business profile first: open Business profile, click Detect from site, check it and save.');
  const fallbackImage = site.organization?.image || '';
  // Per-page plan (chosen schema types + notes), else the run-wide default, else "AI chooses".
  const plans = req.body.plans && typeof req.body.plans === 'object' ? req.body.plans : {};
  const planFor = page => schemas.cleanPlan(plans[page.url] || req.body.defaultPlan || page.schemaPlan);
  lock(run.siteId);
  store.updateRun(run.id, { status: 'generating', error: null });
  setImmediate(async () => {
    try {
      for (const page of pages) {
        updatePage(run.id, page.url, { schema: null, validation: null, existingReview: null, error: null, status: 'generating' });
        try {
          // Only fills a gap left by the crawler; never overrides a page's own detected image.
          const pageData = fallbackImage && !page.pageData.featuredImage ? { ...page.pageData, featuredImage: fallbackImage } : page.pageData;
          let schema; let validation; let plan;
          if (engine === 'rules') {
            // Rules keep their own per-page override; plans picked for the AI don't carry over.
            plan = Object.hasOwn(plans, page.url) ? schemas.cleanPlan(plans[page.url]) : page.rulesPlan || null;
            updatePage(run.id, page.url, { rulesPlan: plan?.types.length ? plan : null });
            const built = builder.build(pageData, { siteUrl: site.url, profile: site.profile, rules: site.rules, plan, pages: run.pages });
            schema = built.schema;
            validation = schemas.validate(schema, page.pageData, { skipBusiness: true });
            validation.warnings.push(...built.missing.map(item => `Left out ${item}.`));
          } else {
            plan = planFor(page);
            updatePage(run.id, page.url, { schemaPlan: plan });
            const generated = await schemas.generatePlanned(pageData, aiOptions, plan);
            schema = generated.schema;
            validation = schemas.validate(schema, page.pageData);
            if (generated.missing.length) validation.warnings.push(`The AI did not produce: ${generated.missing.join(', ')} (after a second attempt). Regenerate this page, or choose a stronger model.`);
          }
          backups.save(site, 'generated', page.url, { schema, plan, validation, engine });
          updatePage(run.id, page.url, { schema, validation, generation: engine === 'rules' ? { engine: 'rules' } : { engine: 'ai', provider: aiOptions.provider, model: aiOptions.model || require('../services/ai').getDefaultModel(aiOptions.provider), keySource: aiOptions.keySource, keyHint: aiOptions.keyHint }, status: validation.valid ? 'generated' : 'invalid', schemaTypes: schema['@graph']?.flatMap(n => n['@type']) || [], generatedAt: new Date().toISOString() });
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
    store.updateRun(run.id, { status: 'publishing', error: null });
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
          backups.save(site, schemaPolicyKind(proposed), page.url, { before: previous, after, publicBefore: existing, policy: req.body.schemaPolicy || 'keep' });
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
        backups.save(site, 'rolled-back', page.url, { restored: page.writeReceipt.before, replaced: page.writeReceipt.after });
        const result = { url: page.url, restored: true, publicVerified, at };
        results.push(result);
        updatePage(run.id, page.url, { status: 'rolled_back', existingReview: null, writeReceipt: { ...page.writeReceipt, rolledBack: true }, rollbackHistory: [...(page.rollbackHistory || []), result], publishResult: { verificationMessage: publicVerified ? 'Previous schema restored and public output verified.' : 'Previous stored value restored. Public output differs; clear caches and inspect the page.' }, publishError: null });
      } catch (error) {
        const result = { url: page.url, restored: false, error: error.message, at };
        results.push(result);
        updatePage(run.id, page.url, { publishError: error.message, rollbackHistory: [...(page.rollbackHistory || []), result] });
      }
    }
    res.json({ success: results.every(result => result.restored), results, run: runView(runFor(run.id)) });
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
    res.json({ success: true, run: runView(runFor(run.id)) });
  } finally { busySites.delete(run.siteId); }
}));
const scriptTag = schema => `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2).replace(/</g, '\\u003c')}\n</script>`;
router.get('/schema-types', (req, res) => res.json({ success: true, types: schemas.SCHEMA_TYPES, moreTypes: schemas.MORE_SCHEMA_TYPES, kinds: builder.KINDS, buildable: builder.BUILDABLE, businessTypes: profiles.BUSINESS_TYPES }));
// Suggest a business profile from the site (not saved until the user confirms it).
router.post('/sites/:id/profile/detect', route(async (req, res) => {
  const site = siteFor(req.params.id);
  const pages = store.listRuns(site.id, 5).flatMap(run => run.pages).filter(page => page.pageData);
  const client = optionalClient(site);
  let homepageHtml = '';
  try { homepageHtml = await scraper.fetchHtml(site.url); }
  catch { try { homepageHtml = client ? await client.fetchContent({ url: `${site.url}/` }) : ''; } catch { /* Detect from crawled pages only. */ } }
  const siteName = client ? await client.siteName() : '';
  res.json({ success: true, profile: profiles.detect({ siteUrl: site.url, homepageHtml, siteName, pages }), crawledPages: pages.length });
}));
router.put('/sites/:id/profile', route(async (req, res) => {
  siteFor(req.params.id);
  const profile = profiles.normalize(req.body.profile);
  if (!profile.name) fail('The business name is required.');
  const rules = req.body.rules ? builder.rulesFor(req.body.rules) : undefined;
  res.json({ success: true, site: siteView(store.setProfile(req.params.id, profile, rules)) });
}));
// Generated schema for a header/footer code plugin (WPCode, Insert Headers and Footers, …) or a manual paste.
router.get('/runs/:id/export', route(async (req, res) => {
  const run = runFor(req.params.id);
  const wanted = req.query.urls ? [].concat(req.query.urls) : null;
  const pages = run.pages.filter(page => page.schema && (!wanted || wanted.includes(page.url)));
  if (!pages.length) fail('No generated schema to export for these pages.', 404);
  const host = new URL(siteFor(run.siteId).url).host;
  const stamp = new Date().toISOString().slice(0, 10);
  if (req.query.format === 'html') {
    res.set('Content-Disposition', `attachment; filename="schematic-${host}-${stamp}.html"`).type('text/plain');
    return res.send(pages.map(page => `<!-- ${page.url} -->\n${scriptTag(page.schema)}`).join('\n\n') + '\n');
  }
  res.set('Content-Disposition', `attachment; filename="schematic-${host}-${stamp}.json"`);
  res.json(pages.map(page => ({ url: page.url, types: page.schemaTypes, generatedAt: page.generatedAt, schema: page.schema })));
}));
router.get('/sites/:id/backups', route(async (req, res) => {
  const site = siteFor(req.params.id);
  res.set('Content-Disposition', `attachment; filename="schematic-backup-${new URL(site.url).host}-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(backups.bundle(site));
}));
router.use((error, req, res, next) => res.status(error.status || 502).json({ success: false, error: error.message }));
module.exports = router;
