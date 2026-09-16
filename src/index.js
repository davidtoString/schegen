require('dotenv').config();
const express = require('express');
const path = require('path');
const authStore = require('./services/authStore');

// Fatal errors should terminate the process so Docker can restart it cleanly.
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exit(1);
});

const indexRoutes = require('./routes/index');
const workspaceRoutes = require('./routes/workspaces');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
// Only trust the explicitly configured reverse proxy, never arbitrary forwarded headers.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

// Middleware
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/css', express.static(path.join(__dirname, '../public/css')));
app.use('/img', express.static(path.join(__dirname, '../public/img')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(require('./auth')());
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/', indexRoutes);
app.use('/api/workspaces', workspaceRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', version: require('../package.json').version }));

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'An internal error occurred. Check the server logs.' });
});

// One-time bootstrap: if no administrator exists yet and DASHBOARD_USER/DASHBOARD_PASSWORD
// are set, create the account from them. Has no effect once an administrator is configured —
// reset it with scripts/admin-user.js instead of editing .env afterward.
async function bootstrapAdminFromEnv() {
  if (authStore.configured()) return;
  const { DASHBOARD_USER, DASHBOARD_PASSWORD } = process.env;
  if (!DASHBOARD_USER || !DASHBOARD_PASSWORD) return;
  try {
    await authStore.setUser(DASHBOARD_USER, DASHBOARD_PASSWORD);
    console.log(`Administrator account bootstrapped from DASHBOARD_USER (username: ${DASHBOARD_USER}). Change it anytime with scripts/admin-user.js.`);
  } catch (error) {
    console.error(`Could not bootstrap administrator from DASHBOARD_USER/DASHBOARD_PASSWORD: ${error.message}`);
  }
}

bootstrapAdminFromEnv().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`Schema Generator running at http://localhost:${PORT}`);
  });

  // Increase server timeout for long-running scrape operations (5 minutes)
  server.timeout = 300000;
  server.keepAliveTimeout = 300000;
});
