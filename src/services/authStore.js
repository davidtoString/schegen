const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const directory = process.env.DATA_DIR || path.join(__dirname, '../../data');
const file = path.join(directory, 'auth.json');
const options = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function read() {
  if (!fs.existsSync(file)) return { user: null, sessions: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function write(data) {
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
async function setUser(username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.@-]{3,80}$/.test(username)) throw new Error('Username must be 3–80 letters, numbers, or _.@- characters.');
  if (typeof password !== 'string' || password.length < 9 || password.length > 256) throw new Error('Use a password of 9–256 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64, options)).toString('hex');
  write({ user: { username, salt, hash }, sessions: [] });
}
async function verify(username, password) {
  const user = read().user;
  if (typeof password !== 'string' || password.length > 256) return false;
  const hash = await scrypt(password, user?.salt || 'unconfigured-account', 64, options);
  const expected = Buffer.from(user?.hash || '00'.repeat(64), 'hex');
  return crypto.timingSafeEqual(hash, expected) && user?.username === username;
}
function createSession() {
  const data = read();
  if (!data.user) throw new Error('Administrator account is not configured.');
  const token = crypto.randomBytes(32).toString('hex');
  const session = { hash: digest(token), csrf: crypto.randomBytes(32).toString('hex'), expires: Date.now() + 8 * 60 * 60 * 1000 };
  data.sessions = data.sessions.filter(item => item.expires > Date.now()).slice(-19);
  data.sessions.push(session); write(data);
  return { token, ...session };
}
function session(token) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
  const data = read();
  const found = data.sessions.find(item => item.hash === digest(token) && item.expires > Date.now());
  return found && data.user ? { ...found, username: data.user.username } : null;
}
function revoke(token) {
  const data = read(); data.sessions = data.sessions.filter(item => item.hash !== digest(token || '')); write(data);
}
module.exports = { setUser, verify, createSession, session, revoke, configured: () => Boolean(read().user) };
