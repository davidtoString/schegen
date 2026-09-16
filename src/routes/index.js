const express = require('express');
const router = express.Router();

// Dashboard: a single-page guided wizard (pages -> action -> review -> apply).
router.get('/', (req, res) => res.render('workspace', { title: 'Schema Workspace' }));
// Former tab URLs redirect to the single-page wizard, preserving query params (site/run).
router.get(['/generator', '/results'], (req, res) => res.redirect(`/${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`));

module.exports = router;
