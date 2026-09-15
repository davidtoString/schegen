const express = require('express');
const router = express.Router();

// Dashboard
for (const [url, section] of [['/', 'sites'], ['/generator', 'generate'], ['/results', 'results']]) {
  router.get(url, (req, res) => res.render('workspace', { title: 'Schema Workspace', section }));
}

// Original advanced generator remains available for manual and database workflows.
router.get('/legacy/generator', (req, res) => {
  res.render('index', {
    title: 'Schema Generator',
    defaultOrg: {
      name: process.env.DEFAULT_ORG_NAME || '',
      url: process.env.DEFAULT_ORG_URL || '',
      logo: process.env.DEFAULT_ORG_LOGO || ''
    }
  });
});

// Results page
router.get('/legacy/results', (req, res) => {
  res.render('results', {
    title: 'Schema Results'
  });
});

module.exports = router;
