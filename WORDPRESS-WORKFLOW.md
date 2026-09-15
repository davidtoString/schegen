# WordPress workflow

The main dashboard implements three operations: **Crawl → Create schema → Insert**.

## One connected workspace

The primary tabs are **Sites & Crawl**, **Generate**, and **Results & Publish**. All three use the same registered site, selected run, server-saved schemas and history. Switching tabs does not reload the page or discard selected rows. The URL carries `site` and `run` identifiers for refreshes/bookmarks, and the last selection is remembered for this browser tab. Results are the actual workspace run records—not a separate browser-local list. Select a different site in the rail to switch context; use Results & Publish → Previous runs to reopen older work.

The previous standalone generator and localStorage results are preserved at `/legacy/generator` and `/legacy/results`, accessible from the footer. They are explicitly labeled legacy and are not silently merged into current run history. Main `/generator` and `/results` URLs now open the connected workspace.

## Connect a site once

1. For Rank Math / Rank Math Pro sites, use **Workspace Connector** (the default). Upload or update `wordpress/schema-workspace.zip` version **1.2.0** under **Plugins → Add New → Upload Plugin** and activate it. Its source is `wordpress/schema-workspace.php`. Direct REST metadata is an advanced alternative for existing writable fields/renderers, but cannot perform Rank Math replacement/removal.
2. In WordPress **Users → Profile → Application Passwords**, create a password for this app. Use a user permitted to edit the target posts.
3. Register the HTTPS WordPress URL, username and Application Password in this app and test the connection.

The connector uses WordPress APIs to resolve URLs, check per-post editing permissions, and save its own metadata. It handles custom database prefixes and avoids needing to guess RankMath, Yoast or ACF field names. It outputs escaped JSON-LD in `wp_head` and does not modify the post body. The theme must call `wp_head`.

### Direct REST: no connector ZIP required

Both integrations use REST and Application Passwords. Neither reads SQL tables. `wp_posts`, `alpha_posts`, and `client_b_42_posts` are WordPress's concern, not app settings. Register each independently hosted site or multisite subsite with its own canonical URL, credentials and mapping. Separate subdirectory installations work when their REST root is `<registered URL>/wp-json/`. Networks with domain mapping need the final canonical URL. A WordPress multisite network itself has not been integration-tested.

Direct REST requires a **single** post metadata field exposed through `register_post_meta` / `register_meta` with `show_in_rest`. Enter the REST property name under `meta` (which may differ from its underlying database key), not a SQL column or table. Pick **JSON string** for REST type `string`, or **JSON object** for REST type `object`. The object's registered JSON Schema must accept the generated graph. Custom post types must support `custom-fields` and expose REST endpoints.

Example configurations:

| Site | Database prefix (not configured in app) | Metadata key | Format |
| --- | --- | --- | --- |
| Editorial site | `alpha_` | `editorial_jsonld` | JSON string |
| Client site | `client_b_42_` | `_client_graph` | JSON object |

For post-type differences within one site, enter overrides using WordPress **type names**, not REST collection names:

```json
{"page":{"key":"page_jsonld","encoding":"json-string"},"product":{"key":"product_graph","encoding":"object"}}
```

The default applies to types without an override. Namespaces and collections are discovered from WordPress, including custom namespaces; full canonical URLs identify targets, not ambiguous slugs. Target resolution currently enumerates at most 10,000 published REST items per operation. Higher-volume sites should use the connector. No automatic fallback changes your integration or writes a different field.

**Storage is not rendering.** Your existing theme/plugin must read this field and output the complete JSON-LD document inside an `application/ld+json` script. The app cannot install PHP through core REST. A field exposed only under `acf`, a read-only SEO head endpoint, a PHP-serialized vendor structure, or an unregistered RankMath/Yoast field is not supported by this adapter. Do not guess vendor field names. Use a documented site integration or the optional connector. The test fixture demonstrates registration/rendering but is NOT production plugin code; it deliberately relaxes authentication for local tests.

Connection testing confirms authentication, not publish readiness. Preview performs OPTIONS schema inspection and an authenticated `context=edit` read for each exact target; missing/read-only/wrong-format fields stop the operation. A preview cannot prove that a subsequent write will be allowed by all site hooks. Insert writes only the selected metadata property, leaving other metadata and post content untouched, then checks the stored value and public HTML. REST pre-write conflict checking is best-effort: core REST has no atomic compare-and-swap across our read/write requests. Avoid concurrent editing of the mapped field.

## 1. Crawl

Automatic discovery enumerates published WordPress posts/pages and REST-exposed custom post types, with pagination. If this fails, it tries a sitemap. You can explicitly supply a sitemap or a list of URLs. Each public page is fetched and its title, text, language, robots directive and existing JSON-LD are stored before generation. Crawling is sequential; errors are recorded per URL. The default limit is 100 pages (`MAX_CRAWL_PAGES`, maximum 1000); the UI reports when the collected list is truncated.

This is a public HTML crawler. JavaScript-only content and WAF-protected pages may require changes on the site. The crawler does not render JavaScript or traverse every internal link. Sitemap discovery may include archives, which the connector will reject at target preview because only published singular content is supported. A static WordPress front page is supported; the latest-posts homepage is not.

## 2. Create schema

### Save AI credentials in the UI

Click **AI Settings** from any workspace tab (no registered site required). Choose the default provider, paste a new OpenAI or Gemini API key, optionally enter a default model ID for each provider, and click **Save settings**. Changes apply immediately without Docker restart. Keys are encrypted in the persistent app data using APP_SECRET and are never returned in settings responses or saved in browser storage. Blank inputs keep existing keys; the explicit remove checkbox removes the UI-saved key. Existing environment keys remain available and cannot be removed through this panel. Saving confirms storage, not provider validity; generation checks actual access and may incur provider charges.

Precedence is request-only override → UI-saved key → environment key. The panel applies to the guided workspace across all sites, not the archived legacy generator. Anyone with dashboard access can use these shared credentials; keep the app local or protect it with authentication and HTTPS. Keep APP_SECRET stable and back up the data volume.

Model controls in AI Settings and Generate are provider-specific dropdowns with a Custom model ID option. Saved custom IDs are preserved; switching providers in Generate retains each provider's in-progress selection. Choosing the default option uses the saved model (or the named app default). The list is a small compatibility-oriented catalog, not a live account-access list or a ranking of the newest models. Custom IDs must support this app's provider API; listing or saving a model does not verify account access. The OpenAI options were checked against [GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o) and [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1) documentation; Gemini options against the [Google model catalog](https://ai.google.dev/gemini-api/docs/models). Existing explicit saved IDs are not silently migrated.

Select successfully crawled pages. **Generation always uses AI**, enforced by the server even if a caller sends `useAI: false`. Configure a key in AI Settings first. Missing keys or provider errors stop generation; there is no deterministic fallback. Provider and model are recorded per page without the key. Generation uses crawled content and existing schema as evidence, not permission to invent claims. A completed crawl opens AI Schema automatically; completed generation opens Review & Publish and prepares a read-only preview.

Review the generated JSON-LD, existing JSON-LD, crawled text, and validation messages in each row. AI output requires factual review. Local validation checks graph structure, URL, content and noindex; it is not a complete Schema.org validator or Google Rich Results Test. Generic WebPage markup does not itself produce a rich result. Generation does not change visible page copy or promise better rankings or agent browsing.

## 3. Insert

Choose **Existing schema** in Review & Publish:

| Action | Effect on selected pages |
| --- | --- |
| Replace existing Rank Math schema (default) | Suppresses Rank Math's page graph and renders the reviewed AI graph. |
| Remove schema from this page | Removes the app graph and suppresses Rank Math output; no generated graph is required. |
| Keep existing | Skips pages with existing JSON-LD or occupied target storage. |
| Replace only the app's previous schema | Replaces app-owned storage; blocks other public graphs. |
| Advanced: keep Rank Math output and add app schema | Preserves Rank Math output; conflicts require review and overlapping IDs can block insertion. |

Click **Preview changes**, open **Review** on each row, approve the before/after checkbox, then **Apply reviewed changes** (or **Remove schema from selected pages**). Confirm the selected action. A fresh matching preview is required; changed storage, public JSON-LD, schema or policy requires another preview. Occupied unowned direct REST fields cannot be overwritten.

Replacement/removal requires Connector **1.2+**. It uses Rank Math's `rank_math/json_ld` filter, not SQL or vendor metadata mutation. The entire Rank Math graph on the selected singular page is suppressed, including its Website, Organization and breadcrumb nodes: ensure the replacement graph retains appropriate factual entities. Rank Math settings and Pro metadata remain intact. Other plugins' output is NOT removed. Free Rank Math was integration-tested; Rank Math Pro still needs staging acceptance with your installed version. Disabling the connector restores ordinary Rank Math output.

Preview resolves each target without writing. Before each external write the app saves a snapshot; confirmed writes retain a receipt with before/after storage and public output. Direct REST snapshots include endpoint, post ID, field, encoding and raw value. The connector also backs up `_schema_workspace_previous`. Both adapters read back storage and fetch public HTML without credentials. Verification accepts a matching document or matching expected nodes inside a merged graph; it is not JSON-LD semantic equivalence or a check of all other page graphs. Removal is verified only when no public JSON-LD scripts remain.

`published` means public JSON-LD was verified. `verification_pending` means storage succeeded but output did not match (often a cache). Purge caches and use **Verify live pages**. Removal has a `schema_removed` state with a separate public verification result. Select pages and use **Undo last change** to restore the last confirmed app change, including prior Rank Math suppression. Undo refuses externally changed storage or changed site/mapping; public restoration is checked separately. Receipts, failures and rollback history remain in each row's records. An interrupted or uncertain write without a confirmed receipt may require manual recovery from the saved snapshot.

## Runtime and records

Use `npm ci` then `npm start`, or `docker compose up --build -d`. Compose binds to `127.0.0.1:3000`, uses Node 24 and persists data in a named volume. Keep APP_SECRET stable and back up the data. The JSON store supports one app process; do not run multiple replicas against it. Active jobs interrupted by restart are marked interrupted, retaining completed results for retry. History is no longer silently truncated after 250 runs.

Existing runs without saved crawl content need to be crawled again. Existing site registrations without an integration setting retain connector behavior; new UI registrations default to the connector. Regenerate older deterministic schemas with AI before publishing. Legacy helper-token registrations can still use `/legacy/generator`, or switch to Application Passwords. Legacy metadata-prefix settings are not used by this workflow. Older specialized HVAC generation remains in the legacy generator. No post-content fallback is used by the guided workflow.

## Verification

`npm test` runs unit and HTTP contract tests covering both adapters, different fields and encodings, custom namespaces, nested URLs, pagination, preview, backups, cache mismatch, read-only/missing fields, conflict detection and rejected/ignored writes. For the real two-site WordPress suite and results, see [TESTING.md](TESTING.md). Always preview and publish one staging page before a production batch. No tests contact production sites or call paid AI services.

### Troubleshooting

- **401/403:** check the username/Application Password, HTTPS, edit permissions and whether the host forwards the Authorization header. Use a dedicated editor rather than sharing an administrator login.
- **Missing metadata:** check the item's OPTIONS response for `schema.properties.meta.properties`, the REST-visible property name, `show_in_rest`, and custom-field support. The app never registers database fields remotely.
- **Saved but unverified:** confirm your renderer exists and Rank Math's Schema module is active, purge caches and verify again. Transformed nodes may not match even if semantically equivalent.
- **404 REST:** confirm the canonical site URL, pretty-permalink REST routing and security-plugin access. Custom REST roots and `?rest_route=` API routing are not currently configurable.
- **Wrong target/not found:** use its actual canonical permalink. Archives, taxonomy pages, search pages and the latest-posts homepage are not singular post targets.
- **Duplicate schema:** review the existing graph before publishing. Disable or adjust overlapping site output deliberately; the app does not turn off your SEO plugins.

References: [WordPress REST metadata](https://developer.wordpress.org/rest-api/extending-the-rest-api/modifying-responses/), [Application Password authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/), [custom REST endpoints](https://developer.wordpress.org/rest-api/extending-the-rest-api/adding-custom-endpoints/), [Google structured data guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies).
