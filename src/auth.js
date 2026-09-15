const express = require('express');
const auth = require('./services/authStore');

module.exports = function authentication() {
  const router = express.Router();
  const origin = new URL(process.env.PUBLIC_URL || 'http://localhost:3000').origin;
  const secure = origin.startsWith('https:');
  if (!secure && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('PUBLIC_URL must use HTTPS outside localhost.');
  if (secure && (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32 || process.env.APP_SECRET.includes('local-development'))) throw new Error('Cloud deployment requires a strong, stable APP_SECRET of at least 32 characters.');
  const cookieName = secure ? '__Host-schema_session' : 'schema_session';
  const cookieOptions = { httpOnly: true, secure, sameSite: 'strict', path: '/' };
  const attempts = new Map();
  let activeLogins = 0;
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    req.sessionToken = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    req.auth = auth.session(req.sessionToken);
    res.locals.currentUser = req.auth?.username || null;
    res.locals.csrfToken = req.auth?.csrf || '';
    next();
  });
  function sameOrigin(req, res, next) {
    if (req.get('origin') !== origin || req.get('sec-fetch-site') === 'cross-site') return res.status(403).send('Request origin rejected. Open the app at its configured PUBLIC_URL.');
    next();
  }
  const loginPage = (res, error = '', status = 200) => res.status(status).render('login', { error, configured: auth.configured() });
  router.get('/login', (req, res) => req.auth ? res.redirect('/') : loginPage(res));
  router.post('/login', sameOrigin, async (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const key = req.ip;
    const entry = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
    if (entry.count >= 10 || activeLogins >= 2 || attempts.size >= 10000) {
      res.set('Retry-After', '900'); return loginPage(res, 'Too many sign-in attempts. Please try again later.', 429);
    }
    entry.count++; attempts.set(key, entry); activeLogins++;
    try {
      if (!await auth.verify(req.body.username, req.body.password)) return loginPage(res, 'Invalid username or password.', 401);
      // Rotate any previous session; passwords and raw session tokens are never saved.
      auth.revoke(req.sessionToken);
      const session = auth.createSession();
      res.cookie(cookieName, session.token, { ...cookieOptions, maxAge: 8 * 60 * 60 * 1000 });
      attempts.delete(key); res.redirect(303, '/');
    } catch (error) { next(error); } finally { activeLogins--; }
  });
  router.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (!req.auth) return req.path.startsWith('/api') ? res.status(401).json({ error: 'Sign in to continue.' }) : res.redirect(303, '/login');
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    sameOrigin(req, res, () => {
      const token = req.get('x-csrf-token') || req.body?._csrf;
      if (typeof token !== 'string' || token !== req.auth.csrf) return res.status(403).json({ error: 'Invalid security token. Refresh and try again.' });
      next();
    });
  });
  router.post('/logout', (req, res) => {
    auth.revoke(req.sessionToken); res.clearCookie(cookieName, cookieOptions); res.redirect(303, '/login');
  });
  return router;
};
