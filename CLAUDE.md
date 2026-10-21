# Schematic

Schematic (formerly Schema Generator / Schema Workspace) crawls WordPress sites, builds JSON-LD schema for each page from a per-site business profile and page rules (AI is an optional second engine), and publishes it into Rank Math's output through a small connector plugin. It can also export the schema for a header-code plugin. Everything is reviewable and can be undone, and every version is backed up.

Live at https://schemagenerator.onpurposemedia.com (Docker on this host, behind Traefik and Cloudflare). Server-wide notes are in `/root/containers/README.md`.

## The flow

### 0. Setup (once per site)
1. **Add site**: name, WordPress URL, WordPress username, and an **Application Password** (Users → Profile). It's encrypted with `APP_SECRET`. An Editor-role user is enough.
3. Install the **Schematic Connector** plugin (sidebar → Download plugin; `wordpress/schema-workspace.php`, zipped as `schema-workspace.zip`) and click **Test connection**.
4. **Business profile** (card on the site page; `site.profile` + `site.rules`): `POST /sites/:id/profile/detect` suggests it (`businessProfile.detect`: existing JSON-LD on crawled pages > homepage logo/tel/mailto/social links/footer address > page-title brand and main city > WP site title; crawler service areas cleaned to city names). The user checks it and saves (`PUT /sites/:id/profile`). `gaps()` reports what is missing for local results vs worth adding. **Page rules** map each page kind to buildable types.
5. Optional: **AI Settings** (sidebar), only for the AI engine. The key is encrypted in `data/workspace.json`; the UI shows a masked hint (`keyHint`: first 7 + last 4), and each AI generation records `keySource` + `keyHint`. Default models are `gpt-4.1-mini` and `gemini-2.5-flash`; nano and flash-lite drop chosen types.

### UI flow (five tabs, any tab can be opened at any time)
**1 Crawl → 2 Choose (pages, Rules/AI, types) → 3 Generate → 4 Review (Compare: live JSON-LD vs new, line diff) → 5 Publish (one button; Undo).** There are no policy, preview or acknowledgement options in the UI: Publish sends `direct: true`, which the server runs as `replace-existing` without a separate preview. Opening a run lands on Review if it has schema (`resetWizard`), so schema from earlier runs can be published straight away. `GET /runs/:id/live` returns the page's current public JSON-LD for Compare. The older preview/policy API (`dryRun`, `schemaPolicy`, `acknowledgeConflicts`) still exists for the tests.

### 1. Crawl (`POST /sites/:id/crawls` → `crawl()` in `src/routes/workspaces.js`)
- **Discovery** tries each source in order and never fails the run: manual URLs → given sitemap → WordPress REST (`wp/v2/types` + each type) → sitemap found via robots.txt or common paths → homepage links → homepage only. Problems are recorded as `discoveryWarning`.
- **Fetching each page** (`crawlPages()`):
  - Public fetch first (`pageScraper.fetchWithRetry`). It starts with an honest crawler User-Agent, because CDNs like Automattic's a8c-cdn return 403 to fake-Chrome requests from servers, then tries a plain request, then browser headers.
  - If the public fetch fails, the page is rebuilt from the authenticated WordPress REST API (`connector.fetchContent`), plus Rank Math's `rankmath/v1/getHead` when headless support is on. These pages get `fetchedVia: 'wordpress-api'`.
  - `pageScraper.parse()` extracts title, content, headings, FAQs, breadcrumbs, phone, service areas, canonical, and existing JSON-LD.
  - A page fails only if both routes fail. **Retry failed pages** (`POST /runs/:id/recrawl`) re-crawls just those.
- The page's original JSON-LD is backed up (`original`).

### 3. Review: generate (`POST /runs/:id/generate`, `engine: 'rules' | 'ai'`; rules is the default)
**Rules engine** (`schemaBuilder.js`, no AI, needs a saved profile):
- `classify()` sorts each page into a kind (home, service, location, hub, about, contact, blog, utility) from its URL and post type. `runView()` sends the kind to the table.
- `build()` emits the business (`/#business`, type from the profile), the WebSite (`/#website`) and the page node (WebPage/AboutPage/ContactPage/CollectionPage) on every page, plus what the kind's rule lists: BreadcrumbList (from crawled breadcrumbs or the URL path, names cleaned with `serviceName`), Service (name from the title before " in City, ST" / "|"; provider = business; areaServed = profile areas, or the page's own city on location pages), FAQPage (verbatim crawled FAQs; reported as left out when the page has none), BlogPosting.
- The business entity is the buildable type `LocalBusiness` (labelled in the UI with the profile's type). Defaults include it for every kind; rules without `version: 2` (saved before it was selectable) get it added back to every kind; `BUSINESS_REQUIRED` kinds (service-area pages) always carry it. When it's off, `dropRefs` removes links to `/#business`. For AI, a `LocalBusiness` pick is sent as the profile's type.
- A per-page **Types** override is stored as `rulesPlan` (separate from the AI's `schemaPlan`, so AI-era choices don't leak into rules).
- `completeness()` (also used for AI output via `validate()`) gives errors for unusable structures (FAQ without answers, unnamed Service, broken breadcrumbs) and warnings for what Google wants (business address/phone, article image/date). Business gaps are skipped per page under rules because the profile card reports them once.

**AI engine** (unchanged):
- **Schema types**: tick types in the picker for the selected pages, or use **Types** on a row for one page. Nothing ticked means the AI chooses. Plans are saved per page as `schemaPlan`.
- `pageSchema.generatePlanned()`:
  1. `generateAI()` sends the page data. Chosen types go in a "REQUIRED OUTPUT" block *after* the page data, with per-type guidance (`TYPE_GUIDANCE`).
  2. `applyPlan()` normalizes the graph (drops untyped nodes and empty values, dedupes `@id`s, prunes refs to this site's entities that don't exist in the graph or in existing JSON-LD), keeps only the chosen types (LocalBusiness accepts subtypes such as HVACBusiness), and makes sure a node carries the page URL.
  3. If a chosen type is still missing, it makes **one repair call** and keeps the better result.
- `validate()` checks for an error-free graph about this URL and not noindex. It warns about a canonical that points elsewhere, content read via the API, and types the AI couldn't produce.
- The generated version is backed up (`generated`). A dry-run publish preview then runs automatically.

### 5. Publish (`POST /runs/:id/publish`, background job with `progress`; UI polls)
- **Preview** (`dryRun: true`): snapshots WordPress's stored value and the live public JSON-LD, then `schemaDecision.assess()` applies the chosen policy:
  - `replace-existing` (default): suppress Rank Math's page graph and output ours.
  - `review`: add ours alongside Rank Math's.
  - `replace-managed`: only replace the app's previous schema.
  - `keep`: skip pages that already have schema.
  - `remove-existing`: delete.
- **Apply** needs the acknowledgement checkbox and a preview that still matches. The connector writes post meta `_schema_workspace_jsonld` (+ `_schema_workspace_suppress_rankmath`), the app reads it back to confirm, then checks the public page. When Rank Math is active, the plugin injects our nodes via the `rank_math/json_ld` filter; without it, the plugin prints its own `<script>` in `wp_head`.
- A write receipt (before/after) is stored on the page and backed up (`published` / `removed`).
- **Verify live pages** re-checks the public HTML. **Undo last change** (`/rollback`) restores the stored value from the receipt, only if WordPress hasn't changed since (backed up as `rolled-back`).

### Alternative: header-code plugin
In the Apply step, **Download &lt;script&gt; tags / JSON** (`GET /runs/:id/export?format=html|json`) for the selected pages, or use **Copy &lt;script&gt; tag** in a page's Review window. Don't also apply through the connector, or the page carries the schema twice.

### Backups
`backupStore.save()` writes one immutable file per event to `data/backups/<host>/<YYYY-MM-DD>/<time>-<slug>-<kind>.json` (kinds: original, generated, published, removed, rolled-back). **Download all backups** (`GET /sites/:id/backups`) returns them as one JSON file. Backup failures are logged, never blocking. Pre-deploy copies of `workspace.json` go to `/root/backups/schematic/`.

## Code map
- `src/routes/workspaces.js`: all API routes, crawl/generate/publish/rollback orchestration, per-site lock (`busySites`). `runView()` strips page data from run responses, and `GET /runs/:id/page` returns one page in full (for Review).
- `src/services/pageScraper.js`: fetching (identity fallback) and HTML extraction.
- `src/services/sitemapParser.js`: sitemaps (redirects, robots.txt, index nesting, tolerant of broken children) and `sameSite()` (www-insensitive).
- `src/services/wordpressConnector.js`: REST client for the connector plugin and WordPress API, plus public verification.
- `src/services/pageSchema.js`: type catalog, prompt, normalize/plan/repair, validation.
- `src/services/schemaDecision.js`: publish policy assessment.
- `src/services/workspaceStore.js`: JSON store (`data/workspace.json`): sites, runs, AI settings, encryption. Marks runs `interrupted` on restart.
- `src/services/backupStore.js`: backup files.
- `src/services/ai/`: OpenAI and Gemini providers and the model list.
- `src/views/` (EJS), `public/js/workspace.js` (vanilla JS UI), `public/css/style.css` (the only stylesheet, monochrome light/dark tokens on `:root` / `[data-theme="dark"]`).
- `wordpress/schema-workspace.php`: the connector plugin. Keep the file name, REST namespace `schema-workspace/v1` and meta keys, or existing installs break. Rebuild the zip after editing it.

## Commands
- **Deploy:** `scripts/deploy.sh` (builds, waits until no crawl/generation/publish is running, then restarts; a restart mid-operation marks that run `interrupted`). Never restart the container directly while someone may be working. The container is `schematic` and the compose service is `schema-workspace`. Data lives in the volume `schegen_schema-workspace-data`.
- **Admin user:** `docker compose -f compose.host.yaml exec schema-workspace node scripts/admin-user.js admin`.
- **Tests:** the production image has no dev dependencies, so run them in `node:24-slim` with a full `npm ci` `node_modules` mounted: `npm test` (node:test; WordPress is faked with express fixtures). Set `CRAWL_INTERVAL_MS=0` in tests.
- **Changelog:** add an entry to `CHANGELOG.md` for each user-visible change.

## Gotchas
- Never pretend to be a browser first when fetching. That is what got crawls 403'd.
- URLs that only redirect or canonicalize to another page (e.g. Strickland's `/mini-split-…`) aren't WordPress posts, so the connector correctly refuses them. They start unchecked in the table.
- AI models are listed in `src/services/ai/index.js` with `reasoning: 'none'` (OpenAI) or the lowest `thinkingLevel` (Gemini 3.x can't fully disable thinking). Current models reject `max_tokens`; the OpenAI provider sends `max_completion_tokens`.
- Don't ask users to write AI instructions: chosen types alone must drive generation (the notes field was removed from the UI on purpose).
