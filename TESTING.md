# Testing and verification

## Verified in this revision

- 53 automated tests passed locally and in Docker, covering authentication and CSRF protections as well as mandatory AI generation, schema policies, before/after review, conflict protection, undo, shared navigation, encrypted settings, and model selection. Prior browser testing confirmed automatic crawl → generation → review transitions, automatic preview and approval-gated Apply.
- Login tests cover unauthenticated UI/API blocking, same-origin checks, CSRF rejection, password hashing, session expiry/revocation, password reset and throttling. The interactive administrator-creation command was checked in an isolated disposable container. The running Docker app was checked for protected guided/legacy routes, logs and connector download; no real administrator password was set by the agent.
- Six end-to-end workflows passed against actual WordPress 7.1 installations using PHP 8.3 and MariaDB 11.4: two prefixes × direct REST, connector, and connector with free Rank Math. Rank Math tests additionally verified replacement, removal and undo.
- Direct REST ran with the connector deactivated; the fixture's registered field and renderer supplied the site-side integration.
- Docker production dependency installation reported zero known vulnerabilities at build time.
- No production WordPress writes or live AI-provider tests were performed. These results do not certify arbitrary hosting/plugin combinations.

## Fast automated suite

```sh
npm test
```

Includes legacy generator tests, encrypted workspace persistence, the guided HTTP workflow, and direct REST contract tests. Direct REST cases cover independent string/object field configurations, per-type overrides, custom namespaces, subdirectory site URLs, nested duplicate slugs, pagination, no-write preview, no credential leakage to public requests, missing/read-only fields, stale snapshots, ignored writes, 403 responses and absent rendering. Internal WordPress template/navigation types are excluded from discovery.

## Real WordPress suite

Requires Docker Desktop running with Linux containers, local Node dependencies installed, and free localhost ports 8091/8092. The first run downloads WordPress and MariaDB images.

```sh
docker compose -f tests/integration/compose.yaml up -d
npm run test:wordpress
docker compose -f tests/integration/compose.yaml stop
```

Wait until both WordPress containers have initialized before invoking the test; if startup is slow, inspect `docker compose -f tests/integration/compose.yaml logs` and retry. The suite uses a separate Compose project (`schegen-integration`), separate database/content volumes, and a temporary app data directory. It does not use your running dashboard data or registered sites. The database is not exposed on a host port. Tests initialize and modify only these dedicated installations; reruns reset their fixture editor's Application Passwords and plugin activation state. Never point this fixture at real data, and never install `tests/integration/fixture.php` on a production site: it enables Application Passwords over HTTP solely for localhost tests.

The two installations share a fixture database but have distinct table prefixes:

| Site | Prefix | REST field | Encoding |
| --- | --- | --- | --- |
| wp-a | `alpha_` | `editorial_jsonld` | JSON string |
| wp-b | `client_b_42_` | `_client_graph` | JSON object |

Each installation is exercised with **direct REST and no connector active**, then the connector, then connector plus free Rank Math (downloaded from WordPress.org). Modes crawl a static front page and custom post type (`catalog/v3/items`), invoke the mandatory AI generation route using a local deterministic test stub, preview, publish, check history, verify public JSON-LD and undo. Rank Math mode also replaces and removes schema, then verifies restoration. Six PASS lines are printed. These tests do not assess real AI output; no paid provider calls are made. Rank Math Pro is not installed or certified by this suite.

The fixture supplies its own field registration and renderer, demonstrating the prerequisites of direct REST. This does not establish compatibility with arbitrary Yoast/RankMath/ACF storage formats or every theme/cache/security plugin. Images are version-family tags, not immutable digests; record the reported versions when reproducing.

Stopping the fixture leaves its test volumes/images for repeat runs, but frees its running CPU/RAM. The main application is unaffected. No volume cleanup is performed automatically.

## Staging acceptance checklist

1. Back up the WordPress site and the app's data volume; keep APP_SECRET stable.
2. Register the site's canonical HTTPS URL with a dedicated editor Application Password.
3. For direct REST, confirm the exact REST-visible meta key, type, per-post permission and frontend renderer. For connector mode, activate the ZIP and ensure the theme calls `wp_head`.
4. Crawl one representative page and one custom post type, if applicable. Review content and existing JSON-LD.
5. Configure AI Settings, generate and check every claim. Separately test your provider/key/model; automated tests stub the provider and do not certify AI output.
6. Update Connector to 1.2+, preview replacement, approve and apply one page. Confirm `published`, inspect public source, and run the applicable Google Rich Results Test and Schema.org validator. On staging also test removal and Undo last change with Rank Math Pro active.
7. Check no duplicate/conflicting entities or visible content changes. Test cache purging and verify again.
8. Only then expand to batches. Keep another editor from changing the mapped field during publishing; direct core REST conflict checking is not atomic.

Generic WebPage schema is not a promise of Google rich results. Local validation is intentionally limited. Public verification compares complete documents or expected nodes within merged graphs, not JSON-LD semantic equivalence or rich-result certification.
