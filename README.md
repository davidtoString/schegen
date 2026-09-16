# Schema Workspace v3.0.0

**Current primary workflow: [Crawl → Create schema → Insert into WordPress](WORDPRESS-WORKFLOW.md).** Authenticate with an Application Password and choose direct REST metadata with a per-site field mapping, or the optional connector for storage and rendering. Database table prefixes need no configuration. See [tests and verification](TESTING.md).

A persistent multi-site application that crawls WordPress websites, generates JSON-LD, performs local checks, and publishes through configurable WordPress integrations. A single guided wizard — Pages → Action → Review → Apply — shares one workspace and selected run per site.

## Docker quick start

```bash
cp .env.example .env
# Set a long random APP_SECRET in .env before using real credentials.
docker compose up --build
```

Open <http://localhost:3000>. Docker stores registered sites, encrypted credentials, crawl runs, generated schemas, and logs in named volumes. Back up both volumes and keep `APP_SECRET` stable; changing the secret makes existing stored credentials unreadable.

For a local-only evaluation, Compose supplies a development secret. Do not use that default on a shared or internet-accessible deployment.

The app requires login. Create your administrator with `docker compose exec schema-workspace node scripts/admin-user.js admin`, then choose a password in the terminal — or set `DASHBOARD_USER`/`DASHBOARD_PASSWORD` in `.env` before first start to bootstrap the account automatically. There is no default password or public registration. See [cloud deployment and account setup](CLOUD-DEPLOYMENT.md) for HTTPS, backups and recovery.

## Guided workflow

Register the canonical WordPress URL and Application Password. For Rank Math / Pro sites install or update Workspace Connector **1.2.0** (download it from the toolbar, or the site dialog). No database table mapping is needed. Then step through the wizard for that site:

1. **Pages** — crawl the site, then check which pages to work with.
2. **Action** — explicitly choose **Create new schema** or **Delete existing schema** for the selected pages.
3. **Review** — for Create, save your key in **AI Settings** and generate (AI is mandatory, with no basic fallback); for Delete, just confirm the pages. Either way, preview before/after per page.
4. **Apply** — approve and write to WordPress. **Undo last change** restores the prior app/Rank Math output state afterward. Run records and snapshots are retained.

The page list stays visible below every step, so which pages you're affecting is never ambiguous, and the step indicator lets you jump back to any step you've already completed.

Removal is reversible suppression of Rank Math output on selected pages, not deletion of Rank Math's settings. Other plugins' schema remains untouched. Rank Math Pro and your live AI model require staging checks; see the testing guide.

Read [WORDPRESS-WORKFLOW.md](WORDPRESS-WORKFLOW.md) for field mappings, limitations and troubleshooting. Writing metadata alone does not render JSON-LD or guarantee rich results.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration)
- [WordPress Integration Methods](#wordpress-integration-methods)
- [Workspace Connector Plugin](#workspace-connector-plugin)
- [Usage](#usage)
- [API Reference](#api-reference)
- [Anti-Firewall Measures](#anti-firewall-measures)
- [Troubleshooting](#troubleshooting)
- [For Future Claude Sessions](#for-future-claude-sessions)

---

## Features

- **AI-Generated JSON-LD**: OpenAI GPT or Google Gemini analyzes each crawled page and generates the appropriate schema graph
- **Persistent Multi-Site Workspace**: Encrypted site profiles and durable crawl/generation/publish history
- **Flexible WordPress Mapping**: Rank Math Workspace Connector, or direct REST metadata with per-post-type overrides
- **Safe Publishing**: Dry-run previews by default, explicit confirmation before writes, and one-click Undo
- **Bulk Schema Removal**: Remove app-published schema from every page of a site in one reviewed action
- **Docker Ready**: Non-root runtime, health check, persistent data/log volumes
- **Single Administrator Login**: Session-based auth, no public signup, CSRF-protected mutations
- **Dark Mode**: Theme toggle with localStorage persistence

---

## Installation

```bash
# Navigate to project directory
cd schema-generator

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your settings (see Configuration section)

# Run in development mode (with auto-reload)
npm run dev

# Or production mode
npm start

# Run tests
npm test
```

**Requirements:**
- Node.js >= 18.0.0
- WordPress with an Application Password (Rank Math recommended for the connector integration)

---

## Configuration

### Environment Variables (.env)

```bash
# Server
PORT=3000
DATA_DIR=./data
MAX_CRAWL_PAGES=100

# Required: encrypts stored credentials. Generate with:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
APP_SECRET=

# Exact browser origin; HTTPS required for cloud domains.
PUBLIC_URL=http://localhost:3000
# For compose.cloud.yaml/compose.traefik.yaml, set your real DNS hostname (no scheme/path).
APP_DOMAIN=

# Optional one-time administrator bootstrap (see Docker quick start above).
DASHBOARD_USER=
DASHBOARD_PASSWORD=

# AI API Keys (schema generation is mandatory; can also be set per-provider in AI Settings)
OPENAI_API_KEY=
GEMINI_API_KEY=
```

See [.env.example](.env.example) for the full annotated list, including `TRUST_PROXY`.

---

## WordPress Integration Methods

Each site is registered with a WordPress Application Password, then one of two integrations:

### Method 1: Workspace Connector (recommended for Rank Math)

Install the small plugin below on the target WordPress site. It exposes dedicated REST endpoints for reading/writing schema and suppressing/restoring Rank Math's own output, so replace/remove actions are fully reversible.

### Method 2: Direct REST metadata

No plugin required. Point the app at any REST-exposed post-meta field (`show_in_rest: true`) and it reads/writes JSON-LD there directly, with optional per-post-type key/encoding overrides. Your theme or another plugin is responsible for rendering that field as JSON-LD.

---

## Workspace Connector Plugin

To use Method 1, install the Workspace Connector on the target WordPress site.

1. Download it from the workspace toolbar ("Download plugin") or `GET /api/workspaces/connector`.
2. In WordPress: **Plugins → Add New → Upload Plugin**, upload the ZIP, and activate.
3. Register the site in the workspace with its URL and an Application Password (**Users → Profile → Application Passwords**).
4. Choose **Rank Math integration — Workspace Connector** as the schema integration and test the connection.

The connector is what makes replace/remove of existing Rank Math output reversible — it stores the prior state so **Undo last change** can restore it exactly.

---

## Usage

1. Start the server (`npm run dev` or `docker compose up`) and open the app. Sign in with your administrator account.
2. Add a site, then step through the wizard: **Pages** (crawl it — sitemap, WordPress discovery, or a pasted URL list — and check which ones to work with), **Action** (Create new schema or Delete existing schema), **Review** (generate with your configured OpenAI/Gemini key, or confirm pages for deletion; preview the diff per page), **Apply** (acknowledge and apply; verify live pages or undo afterward).

### Dark Mode

Click the moon/sun icon in the header to toggle. Preference is saved to `localStorage`.

---

## API Reference

All endpoints are under `/api/workspaces` and require an authenticated session (see [CLOUD-DEPLOYMENT.md](CLOUD-DEPLOYMENT.md)).

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sites` | GET/POST | List or register sites |
| `/sites/:id` | GET/PUT/DELETE | Read, update, or remove a site |
| `/sites/:id/test` | POST | Test the WordPress connection |
| `/sites/:id/crawls` | POST | Start a crawl (sitemap, WordPress discovery, or explicit URLs) |
| `/runs/:id` | GET | Read a run's pages and status |
| `/runs/:id/generate` | POST | Generate AI schema for selected pages |
| `/runs/:id/publish` | POST | Preview (`dryRun: true`) or apply a schema policy to selected pages |
| `/runs/:id/rollback` | POST | Undo the last applied change for selected pages |
| `/runs/:id/verify` | POST | Re-check selected pages' live public schema |
| `/settings/ai` | GET/PUT | Read or save AI provider settings |
| `/connector` | GET | Download the Workspace Connector plugin ZIP |

---

## Anti-Firewall Measures

The app includes measures to avoid being blocked by WordPress security plugins (BlogVault, Wordfence, Sucuri, etc.) while crawling — see `src/services/pageScraper.js`:

- **User-Agent rotation** across a pool of real browser strings
- **Rate limiting** (minimum delay between requests, configurable via `MIN_REQUEST_INTERVAL`)
- **Browser fingerprint headers** (`Sec-Fetch-*`, `sec-ch-ua*`, `Accept-Language`, `Referer`, etc.)

If a target site still blocks crawling, whitelist the app's IP in the WordPress firewall plugin or increase the rate-limit interval.

---

## Troubleshooting

### "Failed to fetch" / crawl errors
- Target site may be blocking automated requests; check for an active firewall plugin
- Try increasing the delay between requests in `pageScraper.js`

### WordPress connection fails
- Confirm the Application Password is current (WordPress revokes it if the user's password changes)
- For the connector integration, confirm the plugin is installed and activated
- For direct REST metadata, confirm the target field is registered with `show_in_rest: true`

### Schema doesn't appear on the live page
- Purge page/CDN caches, then use **Verify live pages**
- Confirm no other plugin is stripping or overriding the JSON-LD output

---

## For Future Claude Sessions

This section contains everything needed to continue development on this project.

### Project Overview

Schema Workspace is a Node.js/Express application that:
1. Crawls WordPress sites (sitemap, REST discovery, or explicit URLs)
2. Generates JSON-LD schema per page with an AI provider (OpenAI or Gemini)
3. Publishes it to WordPress via a Rank Math connector plugin or direct REST metadata, with dry-run preview and undo
4. Persists sites, encrypted credentials, and run history behind a single administrator login

### File Structure

```
schema-generator/
├── src/
│   ├── index.js                    # Express server entry point, admin bootstrap
│   ├── auth.js                     # Session/CSRF middleware
│   ├── routes/
│   │   ├── index.js                # Page routes (renders the workspace view)
│   │   └── workspaces.js           # All /api/workspaces REST endpoints
│   ├── services/
│   │   ├── authStore.js            # Administrator account + sessions (scrypt hashes)
│   │   ├── workspaceStore.js       # Encrypted site/run persistence (data/workspace.json)
│   │   ├── pageScraper.js          # Web scraping with anti-firewall measures
│   │   ├── sitemapParser.js        # XML sitemap parsing
│   │   ├── pageSchema.js           # AI-driven schema generation + local validation
│   │   ├── schemaDecision.js       # Existing-schema policy assessment (keep/replace/remove)
│   │   ├── wordpressConnector.js   # Rank Math Workspace Connector REST client
│   │   ├── wordpressRestMeta.js    # Direct REST post-meta client
│   │   └── ai/
│   │       ├── index.js            # AI provider factory (OpenAI/Gemini) + model lists
│   │       └── providers/
│   │           ├── openai.js
│   │           └── gemini.js
│   └── views/
│       ├── workspace.ejs           # The entire guided UI (sites, generate, publish)
│       ├── login.ejs
│       └── partials/header.ejs
├── public/
│   ├── css/style.css
│   └── js/
│       ├── workspace.js            # All workspace UI logic
│       ├── auth.js
│       └── modelPicker.js
├── wordpress/
│   ├── schema-workspace.php        # Workspace Connector plugin source
│   └── schema-workspace.zip        # Downloadable build (served at /api/workspaces/connector)
├── tests/                          # node:test suite (npm test)
├── scripts/admin-user.js           # Interactive administrator create/reset
└── .env.example
```

### Schema Generation Flow

1. `pageScraper.scrape(url)` — extracts page content, FAQs, phone, existing JSON-LD, etc.
2. `pageSchema.generateAI(page, options)` — calls the configured AI provider to produce a full `@graph`
3. `pageSchema.validate(schema, page)` — local structural checks (not a Rich Results guarantee)
4. `schemaDecision.assess(...)` — compares proposed vs. existing schema and decides skip/block/proceed per the chosen policy
5. `wordpressConnector` or `wordpressRestMeta` — writes, verifies against the public page, and records a rollback receipt

### AI Providers

Located in `src/services/ai/`:
- **OpenAI** (`providers/openai.js`) — `OPENAI_API_KEY`
- **Gemini** (`providers/gemini.js`) — `GEMINI_API_KEY`

Both keys can also be saved (encrypted) per-workspace in **AI Settings**, which take precedence over environment keys.

### Running Tests

```bash
npm test              # Unit/integration tests against fixtures (no real WordPress)
npm run test:wordpress  # Full crawl→generate→publish→rollback against disposable WordPress containers (see tests/integration/)
```

### Common Tasks

**Modify scraping behavior**: edit `src/services/pageScraper.js` (`scrape()`, `extractFAQs()`, `extractPhone()`, `extractServiceAreas()`, etc.).

**Change AI prompts/behavior**: edit `src/services/ai/providers/openai.js` / `gemini.js`, or the shared shaping logic in `src/services/pageSchema.js`.

**Update WordPress integration**: `src/services/wordpressConnector.js` (connector) or `src/services/wordpressRestMeta.js` (direct REST); the connector's own PHP lives in `wordpress/schema-workspace.php` (rebuild the ZIP after editing it).

**Add a workspace UI action**: `src/views/workspace.ejs` (markup) + `public/js/workspace.js` (behavior, reusing the existing `/api/workspaces/*` endpoints where possible instead of adding new server routes).

---

## License

MIT
