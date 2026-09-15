// Run interactively: docker compose exec schema-workspace node scripts/admin-user.js admin
require('dotenv').config();
const readline = require('readline');
const { Writable } = require('stream');
const auth = require('../src/services/authStore');
async function main() {
  const username = process.argv[2];
  if (!username || !process.stdin.isTTY) throw new Error('Run interactively: node scripts/admin-user.js USERNAME (Docker: use compose exec without -T).');
  if (auth.configured()) console.log('This replaces the administrator password/account and signs out all sessions. Workspace data is preserved.');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  const ask = prompt => new Promise(resolve => {
    process.stdout.write(prompt); muted = true;
    rl.question('', answer => { muted = false; process.stdout.write('\n'); resolve(answer); });
  });
  try {
    const password = await ask('New password (9+ characters, hidden): ');
    const confirmation = await ask('Confirm password: ');
    if (password !== confirmation) throw new Error('Passwords do not match. Nothing changed.');
    await auth.setUser(username, password);
    console.log('Administrator saved. Sign in using the username and password you chose.');
  } finally { rl.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
