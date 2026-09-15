# Schema Workspace v3.0.0

**Current primary workflow: [Crawl → Create schema → Insert into WordPress](WORDPRESS-WORKFLOW.md).** Authenticate with an Application Password and choose direct REST metadata with a per-site field mapping, or the optional connector for storage and rendering. Database table prefixes need no configuration. See [tests and verification](TESTING.md). These guides supersede the archived HVAC/RankMath documentation below.

A persistent multi-site application that crawls WordPress websites, generates JSON-LD, performs local checks, and publishes through configurable WordPress integrations. Sites & Crawl, Generate, and Results & Publish share one workspace and selected run. The original standalone generator remains available at `/legacy/generator`.

## Docker quick start

```bash
cp .env.example .env
# Set a long random APP_SECRET in .env before using real credentials.
docker compose up --build
```

Open <http://localhost:3000>. Docker stores registered sites, encrypted credentials, crawl runs, generated schemas, and logs in named volumes. Back up both volumes and keep `APP_SECRET` stable; changing the secret makes existing stored credentials unreadable.

For a local-only evaluation, Compose supplies a development secret. Do not use that default on a shared or internet-accessible deployment.

The app requires login. Create your administrator with `docker compose exec schema-workspace node scripts/admin-user.js admin`, then choose a password in the terminal. There is no default password or public registration. Previous `DASHBOARD_PASSWORD` Basic auth is replaced by session login. See [cloud deployment and account setup](CLOUD-DEPLOYMENT.md) for HTTPS, backups and recovery.

## Guided workflow

1. Register the canonical WordPress URL and Application Password. For Rank Math / Pro sites install or update Workspace Connector **1.2.0** from the dashboard ZIP link. No database table mapping is needed.
2. Save your key in **AI Settings**, then crawl. The app opens AI generation automatically; AI is mandatory, with no basic fallback.
3. Generation opens **Review & Publish**. Choose replace, remove, or keep existing schema; preview each page, approve, and apply. **Undo last change** restores the prior app/Rank Math output state. Run records and snapshots are retained.

Removal is reversible suppression of Rank Math output on selected pages, not deletion of Rank Math's settings. Other plugins' schema remains untouched. Rank Math Pro and your live AI model require staging checks; see the testing guide.

Read [WORDPRESS-WORKFLOW.md](WORDPRESS-WORKFLOW.md) for field mappings, limitations and troubleshooting. Writing metadata alone does not render JSON-LD or guarantee rich results.

## Archived advanced-generator documentation

The following describes older functionality at `/legacy/generator`, not the current guided workspace. Do not use its legacy SQL or metadata-prefix setup for the main workflow.

1. Register a site with either a WordPress Application Password or the included Schema Helper token.
2. Test the connection and adjust post-type endpoints or metadata keys under **Advanced field mapping** when a site differs from RankMath defaults.
3. Discover pages from an auto-detected or explicit sitemap.
4. Select pages and generate JSON-LD with the deterministic engine or a per-run OpenAI/Gemini key.
5. Review schema types and validation status in the saved run.
6. Preview publication without changing WordPress, then explicitly confirm the real publish.

Successful publish records include the previous mapped metadata/schema state returned by WordPress, so each run preserves an audit trail alongside the generated schema and publish result.

The Application Password integration requires target metadata fields to be registered with `show_in_rest=true`. Content injection is disabled by default and can be enabled per site as an explicit fallback. The helper plugin remains the most reliable RankMath integration because it handles RankMath's serialized storage format inside WordPress.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration)
- [WordPress Integration Methods](#wordpress-integration-methods)
- [WordPress Helper Plugin](#wordpress-helper-plugin)
- [Usage](#usage)
- [API Reference](#api-reference)
- [Schema Types Generated](#schema-types-generated)
- [Anti-Firewall Measures](#anti-firewall-measures)
- [Troubleshooting](#troubleshooting)
- [Recent Changes v2.8.1](#recent-changes-v281)
- [For Future Claude Sessions](#for-future-claude-sessions)

---

## Features

- **Multi-Schema Generation**: Creates `@graph` structure with multiple schema types per page
- **Persistent Multi-Site Workspace**: Encrypted site profiles and durable crawl/generation/publish history
- **Flexible WordPress Mapping**: Configurable REST post types, schema meta prefix, rich-snippet key, and custom fields
- **Safe Publishing**: Dry-run previews by default and explicit confirmation before writes
- **Docker Ready**: Non-root runtime, health check, persistent data/log volumes
- **HVAC/Home Services Optimized**: Pre-configured for HVAC, plumbing, electrical, roofing
- **AI Verification**: OpenAI GPT or Google Gemini validates schemas for Google Rich Results compliance
- **Three WordPress Integration Methods**:
  - REST API with Application Passwords
  - Direct MySQL database connection
  - Helper Plugin for secure RankMath injection
- **Bulk Processing**: Process entire sitemaps with progress tracking
- **Auto-Detection**: Extracts organization info, FAQs, phone, service areas from pages
- **Dark Mode**: Dracula theme with localStorage persistence
- **Download All**: Export schemas as JSON or ZIP file
- **Back-to-Top Button**: Easy navigation on long pages

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
- MySQL database (for direct DB method)
- WordPress with RankMath SEO plugin

---

## Configuration

### Environment Variables (.env)

```bash
# Server
PORT=3000

# WordPress REST API (optional - can set via UI)
WP_SITE_URL=https://yoursite.com
WP_USERNAME=admin
WP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx

# Organization defaults (auto-detected if not set)
DEFAULT_ORG_NAME=Your Company Name
DEFAULT_ORG_URL=https://yoursite.com
DEFAULT_ORG_LOGO=https://yoursite.com/logo.png
DEFAULT_BUSINESS_TYPE=HVACBusiness
DEFAULT_AREA_SERVED=Hamilton, Burlington, Oakville
DEFAULT_PHONE=(905) 555-1234

# AI API Keys (for verification features)
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...

# Direct Database Connection (alternative to REST API)
DB_HOST=localhost
DB_USER=wordpress_user
DB_PASSWORD=your_password
DB_NAME=wordpress_db
DB_PORT=3306
DB_TABLE_PREFIX=wp_
```

---

## WordPress Integration Methods

The app supports three methods to insert schemas into WordPress/RankMath:

### Method 1: RankMath Helper Plugin (Recommended)

**Best for**: Most users - secure, easy setup, works with any hosting

Uses a lightweight PHP snippet installed on WordPress that creates REST API endpoints.

**Setup**:
1. Install the helper plugin snippet (see below)
2. In Schema Generator UI, select "RankMath Helper" connection type
3. Enter your site URL and secret token
4. Click "Test Connection" to verify

### Method 2: Direct Database Connection

**Best for**: Full control, bypasses WordPress security, faster bulk operations

Connects directly to MySQL and writes to `wp_postmeta` table using PHP serialization format.

**Setup**:
1. Configure DB credentials in `.env` or enter in UI
2. Requires MySQL access (localhost or remote with proper permissions)
3. Table prefix must match your WordPress installation (default: `wp_`)

### Method 3: WordPress REST API

**Best for**: Standard WordPress API integration without custom plugins

Uses WordPress Application Passwords for authentication.

**Setup**:
1. In WordPress: Users → Your Profile → Application Passwords
2. Create new password, copy it (with spaces)
3. Enter WP URL, username, and app password in Schema Generator

---

## WordPress Helper Plugin

To insert schemas into WordPress/RankMath via the recommended method, install this PHP snippet.

### Installation Steps

1. Install **"Code Snippets"** plugin on WordPress (or use functions.php)
2. Create a new PHP snippet
3. Copy the code from `wordpress-helper-plugin.php` in this project
4. **IMPORTANT**: Change `YOUR_SECRET_TOKEN_HERE` to a secure random string
5. Save and activate the snippet

### What the Plugin Does

Creates these REST API endpoints on your WordPress site:
- `POST /wp-json/schema-generator/v1/find` - Find post by URL/slug
- `GET /wp-json/schema-generator/v1/get/{id}` - Get existing schemas
- `POST /wp-json/schema-generator/v1/insert` - Insert single schema
- `POST /wp-json/schema-generator/v1/insert-multiple` - Insert multiple schemas
- `POST /wp-json/schema-generator/v1/delete` - Delete schemas

All endpoints require the `X-Schema-Token` header with your secret token.

### Verifying Installation

1. Activate the snippet in WordPress
2. In Schema Generator, use "RankMath Helper" connection
3. Enter site URL and secret token
4. Click "Test Connection" - should show "Connected to Schema Generator Helper"

---

## Usage

### Web Interface

1. Start the server: `npm run dev`
2. Open http://localhost:3000
3. Enter your website URL
4. Click "Auto-Detect from Site" to populate organization info
5. Use one of the tabs:
   - **Single URL**: Process one page at a time
   - **Paste URLs**: Paste a list of URLs to process
   - **Sitemap Mode**: Fetch and process entire sitemap
6. Click "Generate Schemas" to create schemas
7. Review generated schemas (AI verification runs automatically if API key set)
8. Click "Publish to WordPress" to insert into RankMath

### Dark Mode

- Click the moon/sun icon in the header to toggle
- Uses Dracula color theme
- Preference saved to localStorage

### Download All Schemas

- After generating schemas, click "Download All"
- Choose format:
  - **JSON**: Single file with all schemas
  - **ZIP**: Separate JSON file per page

---

## API Reference

### Schema Generation

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/generate-schema` | POST | Generate schema for a single URL |
| `/api/ai/generate-schema` | POST | AI-powered generation with auto-verification |
| `/api/ai/generate-schemas-batch` | POST | Batch AI generation for multiple URLs |
| `/api/validate-schema` | POST | Quick local validation (no AI) |

### Page Scraping

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scrape-sitemap` | POST | Parse sitemap, return all URLs |
| `/api/scrape-single` | POST | Scrape single page data |
| `/api/detect-org-info` | POST | Auto-detect organization info from homepage |

### RankMath Helper Plugin

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/rankmath/test-connection` | POST | Test helper plugin connection |
| `/api/rankmath/find-post` | POST | Find post by slug or URL |
| `/api/rankmath/get-schemas` | POST | Get existing schemas for a post |
| `/api/rankmath/insert-schema` | POST | Insert single schema |
| `/api/rankmath/insert-by-url` | POST | Insert schema by page URL |
| `/api/rankmath/insert-multiple-by-url` | POST | Insert multiple schemas |
| `/api/rankmath/delete-schemas` | POST | Delete schemas from a post |
| `/api/rankmath/generate-and-insert` | POST | Full workflow: scrape → generate → insert |

### Direct Database

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/db/test-connection` | POST | Test MySQL connection |
| `/api/db/get-post` | POST | Get post by slug |
| `/api/db/get-schemas` | POST | Get existing RankMath schemas |
| `/api/db/insert-schema` | POST | Insert schema (dryRun: true by default) |
| `/api/db/insert-from-graph` | POST | Insert @graph schema (splits automatically) |
| `/api/db/delete-all-schemas` | POST | Delete all schemas from post |
| `/api/db/rollback` | POST | Rollback to backup state |

### AI Verification

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ai/providers` | GET | Get available AI providers and models |
| `/api/ai/verify` | POST | Full AI verification of page data |
| `/api/ai/verify-page-type` | POST | Verify page type detection |
| `/api/ai/verify-google-compliance` | POST | Check Google Rich Results compliance |
| `/api/ai/verify-faqs` | POST | Verify extracted FAQs |
| `/api/ai/extract-reviews` | POST | Extract reviews from page |

---

## Schema Types Generated

### For Service Pages

| Schema Type | Description |
|-------------|-------------|
| `Service` | Service details with name, description, serviceType, provider, areaServed |
| `HVACBusiness` | LocalBusiness subtype with phone, address, service catalog |
| `FAQPage` | Auto-extracted FAQs from page (if found) |
| `BreadcrumbList` | Navigation path from URL structure |
| `WebPage` | Page metadata linking everything together |

### For Location/Service Area Pages

| Schema Type | Description |
|-------------|-------------|
| `Service` | Service with location-specific areaServed |
| `HVACBusiness` | Business info with location's service area |
| `Place` | Geographic location (city, state) |
| `FAQPage` | Location-specific FAQs (if found) |
| `BreadcrumbList` | Navigation path |
| `WebPage` | Page metadata |

### For Article/Blog Pages

| Schema Type | Description |
|-------------|-------------|
| `Article` | Blog post with headline, author, datePublished, publisher |
| `BreadcrumbList` | Navigation path |
| `WebPage` | Page metadata |

---

## Anti-Firewall Measures

The app includes measures to avoid being blocked by WordPress security plugins (BlogVault, Wordfence, Sucuri, etc.).

### Implemented Protections

1. **User-Agent Rotation** (`src/services/pageScraper.js:7-14`)
   ```javascript
   const USER_AGENTS = [
     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0',
     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0',
     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0',
     'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/122.0.0.0'
   ];
   ```

2. **Rate Limiting** (`src/services/pageScraper.js:33-34`)
   - Minimum 1.5 seconds between requests
   - Configurable via `MIN_REQUEST_INTERVAL` constant

3. **Browser Fingerprint Headers** (`src/services/pageScraper.js:39-61`)
   - Full set of headers that mimic real browser:
   - `Sec-Fetch-Dest`, `Sec-Fetch-Mode`, `Sec-Fetch-Site`, `Sec-Fetch-User`
   - `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`
   - `Accept-Language`, `Accept-Encoding`, `Cache-Control`
   - `Referer` pointing to site homepage

4. **Sitemap Headers** (`src/services/sitemapParser.js:12-25`)
   - Same browser-like headers applied to sitemap requests

### If Still Getting Blocked

- Increase `MIN_REQUEST_INTERVAL` in `pageScraper.js` (try 3000-5000ms)
- Whitelist your IP in the WordPress firewall plugin
- Use a proxy service
- Switch to direct database connection (bypasses web requests entirely)

---

## Troubleshooting

### "Failed to fetch" Error
- Target site may be blocking automated requests
- Check if site has firewall plugin active
- Try increasing delay between requests
- Use direct database connection instead

### "Bulk publish stuck at 42/42"
- Fixed in v2.8.1 - make sure you have latest version
- If still stuck, check browser console for errors

### "Invalid token" on RankMath Helper
- Verify secret token in WordPress snippet matches what you entered
- Check for extra spaces or characters in token
- Ensure snippet is activated in WordPress

### "Schema Generator Helper plugin not found"
- Ensure PHP snippet is activated in WordPress Code Snippets
- Check WordPress debug.log for PHP errors
- Verify REST API is not blocked by security plugin
- Try visiting `yoursite.com/wp-json/schema-generator/v1/find` directly

### "Post not found"
- Verify post/page is published (not draft/private)
- Check slug matches the URL path
- For hierarchical pages, try using full URL instead of slug

### Connection Timeout
- Increase timeout in request options
- Check server/network connectivity
- Site may be slow or overloaded

---

## Recent Changes v2.8.1

### Bug Fixes
- **Fixed "failed to fetch"**: Updated User-Agent headers to realistic browser strings with full fingerprint
- **Fixed bulk publish hang**: UI was blocking on completion - wrapped DOM updates in setTimeout
- **Fixed SQL injection risk**: Table prefix now sanitized to alphanumeric + underscore only
- **Fixed undefined handling**: phpSerialize now explicitly handles undefined values
- **Improved Gemini validation**: Better error messages for blocked/empty API responses

### New Features
- **Dark Mode**: Full Dracula color theme with CSS variables
- **Theme Persistence**: Saves preference to localStorage
- **Back-to-Top Button**: Appears on scroll for easy navigation
- **Download All Schemas**: Export as single JSON or ZIP with separate files
- **User-Agent Rotation**: Pool of 6 different real browser user agents
- **Rate Limiting**: 1.5 second minimum delay between scrape requests
- **Browser Fingerprinting**: Complete Sec-Fetch-*, sec-ch-ua headers

### Files Modified in v2.8.1
- `src/services/pageScraper.js` - User-Agent rotation, rate limiting, browser headers
- `src/services/sitemapParser.js` - Browser-like headers for sitemap requests
- `src/services/databaseClient.js` - SQL injection fix, undefined handling
- `src/services/ai/providers/gemini.js` - Response validation improvements
- `public/css/style.css` - Dracula theme, dark mode CSS variables
- `public/js/app.js` - Theme toggle, download all, bulk publish fix
- `src/views/index.ejs` - Back-to-top button, download button
- `src/views/partials/header.ejs` - Theme toggle button in nav

---

## For Future Claude Sessions

This section contains everything needed to continue development on this project.

### Project Overview

Schema Generator is a Node.js/Express web application that:
1. Scrapes WordPress websites to extract page content
2. Generates JSON-LD schemas optimized for HVAC/home services
3. Validates schemas using AI (OpenAI GPT or Google Gemini)
4. Injects schemas into WordPress via RankMath SEO plugin

### File Structure

```
schema-generator/
├── src/
│   ├── index.js                    # Express server entry point (port 3000)
│   ├── routes/
│   │   ├── index.js                # Page routes (renders EJS views)
│   │   └── api.js                  # ALL REST API endpoints (~1600 lines)
│   ├── services/
│   │   ├── pageScraper.js          # Web scraping with anti-firewall measures
│   │   ├── sitemapParser.js        # XML sitemap parsing
│   │   ├── pageTypeDetector.js     # Detects article vs service vs location
│   │   ├── schemaGenerator.js      # Main schema generation orchestrator
│   │   ├── wordpressClient.js      # WP REST API client (Application Passwords)
│   │   ├── databaseClient.js       # Direct MySQL connection for RankMath
│   │   ├── rankMathClient.js       # Helper plugin REST client
│   │   ├── logger.js               # Activity and token usage logging
│   │   └── ai/
│   │       ├── index.js            # AI provider factory (OpenAI/Gemini)
│   │       ├── providers/
│   │       │   ├── openai.js       # OpenAI GPT integration
│   │       │   └── gemini.js       # Google Gemini integration
│   │       ├── schemaGenerator.js  # AI-powered schema generation
│   │       └── verifier.js         # AI schema verification
│   ├── schemas/                    # Individual schema type generators
│   │   ├── article.js              # Article/BlogPosting schema
│   │   ├── service.js              # Service schema (HVAC-optimized)
│   │   ├── location.js             # Location/service area pages
│   │   ├── faq.js                  # FAQPage schema
│   │   ├── localBusiness.js        # HVACBusiness/LocalBusiness schema
│   │   └── breadcrumb.js           # BreadcrumbList schema
│   └── views/
│       ├── index.ejs               # Main UI page
│       ├── results.ejs             # Results display page
│       └── partials/
│           └── header.ejs          # Navigation with theme toggle
├── public/
│   ├── css/style.css               # All styles including Dracula dark theme
│   └── js/app.js                   # Frontend JavaScript (~800 lines)
├── tests/
│   └── schemaGenerator.test.js     # 36 unit tests
├── scripts/
│   └── test-db-connection.js       # Database connection test utility
├── logs/
│   └── activity.json               # Activity logs
├── wordpress-helper-plugin.php     # PHP snippet for WordPress
├── .env.example                    # Environment template
└── package.json                    # Dependencies and scripts
```

### Three WordPress Integration Methods

1. **REST API** (`src/services/wordpressClient.js`)
   - Uses WordPress Application Passwords
   - Standard WP REST API endpoints
   - Less reliable for RankMath schema injection

2. **Direct Database** (`src/services/databaseClient.js`)
   - Connects directly to MySQL
   - Uses PHP serialization format for RankMath
   - Most reliable, bypasses all WP security
   - Has dry-run mode (default) and rollback capability

3. **Helper Plugin** (`src/services/rankMathClient.js`)
   - Uses custom PHP snippet on WordPress
   - Creates dedicated REST endpoints
   - Secure via secret token authentication
   - Recommended method for most users

### RankMath Schema Storage Format

Schemas are stored in `wp_postmeta` table:

```
Meta Key: rank_math_schema_{SchemaType}
Example: rank_math_schema_Service, rank_math_schema_FAQPage

Value: PHP serialized array with structure:
a:X:{
  s:8:"metadata";a:Y:{
    s:5:"title";s:7:"Service";
    s:4:"type";s:6:"custom";
    s:9:"shortcode";s:14:"s-abc123def456";
    s:9:"isPrimary";s:1:"1";        // Only for primary schema
    s:4:"name";s:11:"%seo_title%";
    s:11:"description";s:17:"%seo_description%";
  }
  s:5:"@type";s:7:"Service";
  s:4:"name";s:...;
  // ... rest of schema properties
}
```

### Page Type Detection Logic

Located in `src/services/pageTypeDetector.js`:

- **Articles**: Has publish date AND author, OR `/blog/` in URL
- **Services**: `/service/` in URL, OR keywords like "repair", "installation", "maintenance"
- **Locations**: `/location/` in URL, OR city names with service keywords

### Schema Generation Flow

1. `pageScraper.scrape(url)` - Extracts page content, FAQs, phone, etc.
2. `pageTypeDetector.detect(url, pageData)` - Determines page type
3. `schemaGenerator.generate(pageType, pageData, orgInfo, options)` - Creates @graph
4. Individual schema generators called based on page type:
   - `articleSchema.generate()` for articles
   - `serviceSchema.generate()` for services
   - `localBusinessSchema.generate()` for business info
   - `faqSchema.generate()` for FAQs
   - `breadcrumbSchema.generate()` for navigation

### Anti-Firewall Implementation

Located in `src/services/pageScraper.js`:

```javascript
// Line 7-14: User-Agent pool
const USER_AGENTS = [...];

// Line 19-21: Random selection
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Line 33-34: Rate limiting
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1500; // 1.5 seconds

// Line 39-61: Full browser headers
function getBrowserHeaders(url) {
  return {
    'User-Agent': getRandomUserAgent(),
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'sec-ch-ua': '"Chromium";v="122"...',
    // ... more headers
  };
}

// Line 67-73: Rate limit enforcement in scrape()
const timeSinceLastRequest = now - lastRequestTime;
if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
  await delay(MIN_REQUEST_INTERVAL - timeSinceLastRequest);
}
```

### AI Providers

Located in `src/services/ai/`:

- **OpenAI** (`providers/openai.js`): Uses `OPENAI_API_KEY`, models: gpt-4o, gpt-4-turbo, gpt-3.5-turbo
- **Gemini** (`providers/gemini.js`): Uses `GEMINI_API_KEY`, models: gemini-1.5-pro, gemini-1.5-flash

Default provider is Gemini (set in `ai/schemaGenerator.js`).

### Key Configuration Points

To modify behavior:

- **Rate limiting**: Change `MIN_REQUEST_INTERVAL` in `pageScraper.js:34`
- **User agents**: Update `USER_AGENTS` array in `pageScraper.js:7-14`
- **Default business type**: Change `DEFAULT_BUSINESS_TYPE` in `.env`
- **Schema types generated**: Modify `schemaGenerator.js:generate()` function
- **AI prompts**: Edit prompts in `ai/schemaGenerator.js` and `ai/verifier.js`

### Running Tests

```bash
npm test  # Runs 36 tests covering all schema generators
```

### Common Tasks

**Add new schema type:**
1. Create new file in `src/schemas/`
2. Import in `src/services/schemaGenerator.js`
3. Add to `generate()` function
4. Add tests in `tests/schemaGenerator.test.js`

**Modify scraping behavior:**
- Edit `src/services/pageScraper.js`
- Key functions: `scrape()`, `extractFAQs()`, `extractPhone()`, `extractServiceAreas()`

**Change AI behavior:**
- Edit prompts in `src/services/ai/schemaGenerator.js` (SCHEMA_PROMPT)
- Edit verification in `src/services/ai/verifier.js`

**Update WordPress integration:**
- Helper plugin: `src/services/rankMathClient.js` + `wordpress-helper-plugin.php`
- Direct DB: `src/services/databaseClient.js`
- REST API: `src/services/wordpressClient.js`

---

## License

MIT
