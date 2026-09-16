const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const scraper = require('../src/services/pageScraper');

async function serveAndScrape(html) {
  const app = express();
  app.get('/page', (req, res) => res.send(html));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    return await scraper.scrape(`http://127.0.0.1:${port}/page`);
  } finally { server.close(); }
}

test('featured image extraction trusts og:image but filters decorative fallbacks', async () => {
  const declared = await serveAndScrape(`<html><head><title>t</title><meta property="og:image" content="https://example.com/hero.jpg"></head><body><article><img src="/logo-divider.svg" width="20" height="20"></article></body></html>`);
  assert.equal(declared.featuredImage, 'https://example.com/hero.jpg', 'og:image is trusted even when a bad fallback candidate also exists');

  const skipsSvgAndSmall = await serveAndScrape(`<html><head><title>t</title></head><body><article>
    <img src="/divider.svg">
    <img src="/spacer.gif" width="10" height="10">
    <img class="logo" src="/site-logo.png" width="300" height="300">
    <img src="/real-photo.jpg" width="800" height="600">
  </article></body></html>`);
  assert.equal(skipsSvgAndSmall.featuredImage, '/real-photo.jpg', 'SVGs, tiny images and logo-classed images are skipped in favor of a plausible content photo');

  const nothingUsable = await serveAndScrape(`<html><head><title>t</title></head><body><article><img src="/divider.svg"><img src="/icon-bullet.png" width="16" height="16"></article></body></html>`);
  assert.equal(nothingUsable.featuredImage, '', 'no plausible image falls back to empty string rather than a decorative one');
});
