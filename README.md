# Schema Workspace v3.0.0

A Docker-first app that crawls WordPress sites, generates JSON-LD schema with AI (OpenAI or Gemini), and publishes it back to WordPress — with dry-run previews, per-page review, and one-click undo. See [WORDPRESS-WORKFLOW.md](WORDPRESS-WORKFLOW.md) for field mappings and troubleshooting, [CLOUD-DEPLOYMENT.md](CLOUD-DEPLOYMENT.md) for HTTPS/auth/backups, and [TESTING.md](TESTING.md) for what's verified.

## Docker quick start

```bash
cp .env.example .env
# Set a long random APP_SECRET in .env before using real credentials.
docker compose up --build
```

Open <http://localhost:3000>. Sites, encrypted credentials, and run history persist in named volumes — keep `APP_SECRET` stable, or existing stored credentials become unreadable.

The app requires login. Create your administrator with `docker compose exec schema-workspace node scripts/admin-user.js admin`, or set `DASHBOARD_USER`/`DASHBOARD_PASSWORD` in `.env` before first start to bootstrap it automatically. There's no default password or public registration.

## Guided workflow

Register a site with a WordPress Application Password, then step through the wizard:

1. **Pages** — crawl the site, check which pages to work with.
2. **Action** — explicitly choose **Create new schema** or **Delete existing schema**.
3. **Review** — Create generates with your AI key; Delete just confirms the pages. Either way, preview before/after per page first.
4. **Apply** — approve and write to WordPress. **Undo last change** and **Verify live pages** stay available afterward.

The page list stays visible at every step, and the step indicator lets you jump back to anything already completed.

## WordPress integration

Two ways to connect a site, chosen per-site in its settings:

- **Workspace Connector** (recommended for Rank Math) — download the plugin from the toolbar, install it on the WordPress site, and activate. It exposes dedicated endpoints for reading/writing schema and reversibly suppressing Rank Math's own output.
- **Direct REST metadata** — no plugin needed. Point the app at any REST-exposed post-meta field (`show_in_rest: true`); your theme is responsible for rendering it as JSON-LD.

## Configuration

Key variables (see [.env.example](.env.example) for the full list):

```bash
APP_SECRET=          # required — encrypts stored credentials
PUBLIC_URL=          # exact browser origin; HTTPS required for cloud domains
OPENAI_API_KEY=      # or set per-provider in AI Settings instead
GEMINI_API_KEY=
```

## Local development

```bash
npm install
cp .env.example .env
npm run dev     # auto-reload
npm test        # unit/integration tests, no real WordPress needed
```

Requires Node.js >= 18.

## License

MIT
