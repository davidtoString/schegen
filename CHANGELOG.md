# Changelog

All notable changes to the Schematic project (formerly Schema Generator / Schema Workspace).

## [3.2.2] - 2026-10-21

### Removed
- The "Use a different API key for this run" field in the Review step; AI runs always use the key saved in AI Settings (shown with its preview).

### Added
- Up/down scroll navigator in the bottom-right corner; each arrow shows only when there is somewhere to go. Notices now appear just above it.

### Fixed
- Updates now show up right after a deploy: CSS and JS URLs carry a content hash (`?v=…`), so Cloudflare's 4-hour browser cache can't serve stale files.

## [3.2.0] - 2026-10-21

### Added
- **Rule-based schema (new default, no AI).** Each site has a **business profile** (detected from the site, confirmed once) and **page rules** (which types each kind of page gets). Pages are sorted into kinds (home, service, service-area, listing, about, contact, blog, utility) and get the business, website, page, breadcrumbs, Service and verbatim FAQs, all linked. It's instant, free and identical every run. Strickland: 77/77 crawled pages build valid schema.
- **Completeness checks** for what Google needs per type, on both engines; profile gaps are shown once on the profile card.
- **Masked API key previews** (first 7 + last 4 characters) in AI Settings and the Review step; each AI-generated page records which key was used.

### Changed
- AI is now optional: choose **Rules** or **AI** in the Review step. AI Settings are only needed for AI.

## [3.1.1] - 2026-10-21

### Fixed
- **Chosen schema types were dropped** (e.g. FAQPage + Service produced only FAQPage on a third of Strickland's pages). The prompt told the model to build a "complete page graph" while the type choice came first and was easy to ignore; the filter then removed everything but FAQPage. Chosen types are now a hard requirement stated after the page data, with per-type guidance, plus one repair call for any type still missing.
- Service names are the plain service ("AC Installation"), not the marketing headline or SEO title.
- Preview/publish errors show WordPress's reason instead of "Request failed with status code 404".
- A page whose node lacks the exact page URL (trailing slash, dropped `url`) no longer fails validation.

### Changed
- Default models: **gpt-4.1-mini** (was gpt-4.1-nano) and **gemini-2.5-flash** (was flash-lite).
- Removed the two warnings shown on every page ("Local checks do not certify…", "Existing JSON-LD detected…"); the publish preview already covers existing schema.
- Pages whose canonical URL points elsewhere start unchecked.
- **In-app guide rewritten** ("How it works" in the sidebar, also linked from the empty state) to match the current flow.
- **New layout:** ElevenLabs-style shell with a left sidebar (sites, AI Settings, plugin, Help, theme, account), monochrome light and dark themes that follow the system setting, wizard tabs, and a slimmer table, history and dialogs. The old stylesheet was replaced.
- Removed the "Instructions for the AI" field from the type picker and the per-page Types pop-up; chosen types alone drive generation.
- **Faster site switching:** selecting a site is one request that returns run history without page data, plus the chosen run with a light per-page summary; crawled content loads when Review is opened. Strickland went from 1.8 MB to about 190 KB per click, and progress polling during runs shrank the same way. The sidebar highlights the new site immediately.

## [3.1.0] - 2026-10-20

### Changed
- Renamed the app to **Schematic**; the WordPress plugin is now **Schematic Connector 1.3.0** (same endpoints and stored data, so existing installs keep working).

### Fixed
- **Crawls blocked with HTTP 403** on CDNs such as Automattic's (a8c-cdn): the crawler now identifies itself honestly first, and only then tries other request identities.
- **Sitemaps that redirect** (e.g. `/sitemap.xml` → `/sitemap_index.xml`) are followed. Sitemaps are also found through robots.txt, and one broken child sitemap no longer fails the whole crawl.
- Discovery falls through WordPress API → sitemap → homepage links → homepage instead of failing the run.
- Pages whose public URL is blocked are read through the authenticated WordPress REST API (plus Rank Math's headless `getHead`, when enabled). **Retry failed pages** re-crawls only the failures.

### Added
- **Schema types per page**: pick types for the selected pages (or per page with **Types**), plus optional AI instructions. Output is filtered to those types, and types the page can't support are reported.
- Graph cleanup after generation: empty values, untyped nodes, duplicate `@id`s and dangling references to this site's entities are removed.
- Warnings for canonical URLs that point elsewhere and for content read through the WordPress API.
- **Export for header code plugins**: download `<script>` tags or JSON for selected pages, or copy one page's from its Review window.
- **Backups**: original page JSON-LD, every generated version, and every publish/removal/undo are written to `data/backups/<host>/<date>/` and can be downloaded in one file.

## [2.8.1] - 2026-02-03

### Fixed

#### Service Provider Address Requirement
- **Fixed "Missing field address" error** for Service.provider (HVACBusiness)
- AI prompt now explicitly requires complete address in Service.provider
- Added post-processing safety net that ensures provider always has address
- Fixed standalone HVACBusiness also getting complete address (not just Service.provider)
- Now handles both missing AND incomplete addresses
- Validation now treats missing provider.address as ERROR (not warning)
- Google Rich Results Test will no longer fail for missing provider address

#### Schema Replacement on Publish
- **Fixed duplicate schemas issue** - Old schemas are now deleted before inserting new ones
- Previously, publishing new schemas would ADD to existing ones instead of replacing
- This caused Google to see both old (broken) and new schemas on the same page
- All insert endpoints now delete existing schemas first by default (`replaceExisting: true`)

#### FAQ Extraction Fix
- **Fixed Elementor nested accordion FAQ extraction** - answers without `<p>` tags now extracted
- Previously only found answers inside `<p>` tags, missing text directly in `.e-con` container
- Now properly extracts all 5 FAQs from pages like `/ac-service-hamilton/`

---

## [2.8.0] - 2026-02-02

### Added

#### AI-Powered Schema Generation with Auto-Verification
- **Complete workflow**: Crawl → Analyze → Generate → Verify → Review → Publish
- AI generates ALL appropriate schemas based on page type (Service, FAQPage, HVACBusiness, BreadcrumbList, WebPage)
- **Auto-verification** runs immediately after generation
- FAQs extracted from page content only (never invented by AI)

#### AI Verification (Data Consistency + Google Compliance)
- **Data accuracy checks**:
  - Business name matches page content
  - Address/location is correct
  - Phone number verified against page
  - Service areas actually mentioned on page
  - FAQs match page content (not fabricated)
- **Google Rich Results compliance** check
- **Coherence check**: Schema data is internally consistent
- Returns `canPublish: true/false` status

### Fixed
- **Gemini models**: Updated to `gemini-2.0-flash` (1.5 models deprecated)
- **Elementor FAQ extraction**: Added support for nested accordion (`details.e-n-accordion-item`)
- **Regex bug**: Fixed `Cannot read properties of undefined (reading 'split')` on location pages
- **Canadian addresses**: Default country now "CA", properly detects ON/BC/AB provinces

### Changed
- Default AI provider changed to Gemini
- AI schema generator now produces all appropriate schema types for each page type
- Verification integrated into generation flow (not separate step)

---

## [2.5.0] - 2026-02-01

### Added

#### Google Rich Results Compliance Verification
- **New "Check Google Compliance" button** - Validates schemas against Google Rich Results requirements
- Automatic compliance check after generating each schema
- Visual compliance badges: ✓ Google Ready, ⚠ Valid (warnings), ✗ Needs Fixes
- Compliance legend explaining badge meanings
- **Local validation** (instant, no API needed):
  - Checks all required fields per Google documentation
  - Validates LocalBusiness (name, address required)
  - Validates Service (name, provider, areaServed recommended)
  - Validates Article (headline, author, datePublished, image)
  - Validates FAQPage (mainEntity with questions/answers)
  - Validates Review (author, rating)
  - Checks BreadcrumbList structure
- **AI verification** (detailed analysis with OpenAI/Gemini):
  - Cross-validates schema data against actual page content
  - Verifies business name, address, phone accuracy
  - Checks if service areas are actually mentioned on the page
  - Detects fabricated or inaccurate FAQs
  - Shows rich results eligibility by schema type
  - Provides critical fixes with specific recommendations
  - Confidence score for overall verification
- New API endpoints:
  - `POST /api/ai/verify-google-compliance` - Full AI compliance check
  - `POST /api/validate-schema` - Quick local validation (no AI)
- Detailed compliance view in schema preview modal:
  - Errors (must fix before publishing)
  - Warnings (recommended improvements)
  - Recommendations (nice to have)
  - AI summary and confidence score
- Auto-detect confirmation dialog when org info not filled

---

## [2.4.1] - 2026-02-01

### Fixed

#### Google Rich Results Compliance
- **Fixed "Missing field address" error** - LocalBusiness now always includes address
- Address is auto-generated from Areas Served if not explicitly provided
- Added address input fields to UI (Street, City, State, ZIP)
- Provider in Service schema now includes address and areaServed
- Changed single areaServed from "Place" to "City" type (more specific)
- Provider type now correctly uses businessType (HVACBusiness by default)

---

## [2.4.0] - 2026-01-31

### Added

#### AI Verification (OpenAI & Gemini)
- Modular AI provider system - easy to add new models
- Support for OpenAI (GPT-4o, GPT-4 Turbo, GPT-4, GPT-3.5)
- Support for Google Gemini (1.5 Pro, 1.5 Flash, Pro)
- **API key input in UI** - no need to configure .env, enter key directly
- Expandable "View AI Prompts Used" section showing all prompts
- AI verification features:
  - Page type verification with confidence scores
  - Business info validation
  - Review/testimonial extraction
  - FAQ verification and missed FAQ detection
  - Location/city extraction improvement
- "Verify Selected with AI" and "Verify All with AI" buttons
- Visual display of AI findings (corrections, reviews, missed FAQs)
- API endpoints for AI verification

---

## [2.3.0] - 2026-01-31

### Added

#### Paste URLs Mode
- New "Paste URLs" tab for processing a custom list of URLs
- Paste URLs one per line
- Live URL count as you type
- Parses and deduplicates URLs automatically
- Full support for filtering and bulk publishing

---

## [2.2.0] - 2026-01-31

### Added

#### Location Page Support
- New page type: `location` for service area pages (e.g., "AC Repair in Houston")
- Location-specific schemas: Service, HVACBusiness, Place with city/state
- Auto-detection of city names from URL and content
- Location filter tab and bulk publish button

---

## [2.1.0] - 2026-01-31

### Added

#### Filter & Bulk Publish by Page Type
- Filter tabs to view: All, Services, Locations, Blog Posts
- Live counts showing total, pending, and inserted schemas
- Bulk publish buttons for each page type
- Select-all checkbox respects current filter
- Filter persists after publishing

---

## [2.0.0] - 2026-01-31

### Added

#### Multi-Schema Generation (@graph)
- Schemas are now generated as a combined `@graph` structure
- Single page can include: Service, HVACBusiness, FAQPage, BreadcrumbList, WebPage
- Proper `@id` references between schemas for better SEO

#### HVAC & Home Services Optimization
- 40+ HVAC-specific service type patterns (AC repair, furnace, heat pump, etc.)
- Auto-detection of business type (HVAC, Plumber, Electrician, Roofing)
- HVACBusiness schema type for local business
- Service catalog with common HVAC offerings

#### Auto-Detect Organization Info
- New `/api/detect-org-info` endpoint
- Scans homepage footer, header, and meta tags
- Extracts: company name, logo, phone, email, address, service areas
- Detects social profiles (Facebook, Yelp, Google, etc.)
- Auto-populates form fields with one click

#### FAQ Schema Generation
- Automatic FAQ detection from page content
- Supports: accordions, FAQ sections, definition lists, Q&A patterns
- Validates FAQ quality before including
- Limits to 10 FAQs per Google guidelines

#### Breadcrumb Schema
- Auto-extracts breadcrumbs from page HTML
- Falls back to URL-based generation
- Supports Yoast, RankMath, and common breadcrumb selectors

#### Enhanced Service Schema
- HVAC-specific service type detection
- Multiple areas served support (comma-separated)
- Service category classification
- Offers and potentialAction for booking

#### UI Improvements
- Schema type badges showing what's included
- Validation status indicator
- Data summary (FAQ count, phone detected, areas)
- Business type dropdown selector
- Phone number field

### Changed
- Service provider changed from Organization to LocalBusiness
- Schemas no longer have individual `@context` (now in parent)
- Updated page type detector with HVAC URL patterns
- Improved test coverage (36 tests)

### Fixed
- Schema validation now supports @graph structure
- Proper handling of multiple service areas


## [1.0.0] - Initial Release

### Features
- Single URL schema generation
- Sitemap bulk processing
- Article and Service schema types
- WordPress/RankMath integration
- Dry run preview mode
- Page type auto-detection
