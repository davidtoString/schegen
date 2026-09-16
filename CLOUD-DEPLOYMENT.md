# Private Docker cloud deployment

The app now requires a single administrator login for the dashboard, API, records, and connector download. There is no public signup, default password, or unauthenticated workspace access. All sites belong to this one administrator; this is not a multi-tenant SaaS.

## Local account setup

Two ways to create the administrator account:

- **Interactive (no password touches disk/env):**

  ```sh
  docker compose exec schema-workspace node scripts/admin-user.js admin
  ```

  Choose and confirm a password longer than 8 characters (9 minimum, 256 maximum). Input is hidden and is not passed as a command argument or environment variable. Replace `admin` with your preferred username.

- **Env bootstrap (convenient for first-run automation):** set `DASHBOARD_USER`/`DASHBOARD_PASSWORD` in `.env` before starting the container. If no administrator exists yet, the app creates one from those values on startup and logs that it did so. Once an administrator exists, these variables have no further effect — leaving them in `.env` does not reset the password on later restarts. To change the password afterward, use the interactive script above (don't just edit `.env` and restart).

Either way, open http://localhost:3000 and sign in. Use the exact configured `PUBLIC_URL`; another origin will fail security checks.

The interactive script resets/replaces the administrator and revokes all sessions on every run. It does not change sites, AI keys, crawl records or schemas. Password recovery requires server terminal access (or the env bootstrap, if the account was never configured); there is no email reset or public account creation.

## Cloud server with HTTPS

1. Use a Linux server with Docker Engine and Compose. Point your domain's DNS to the server. Permit inbound TCP 80/443 and restrict SSH to administrators. Do not publicly expose port 3000 or 8080.
2. Copy the project (excluding `.env`, local data and node_modules) or clone your repository on that server. Create `.env` from `.env.example` and set `APP_DOMAIN=schema.yourdomain.com` and a strong permanent `APP_SECRET` (at least 32 characters). For a new installation, generate a random secret using `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep it in your password manager. For migration, reuse the EXISTING secret instead.
3. Start the app and included Caddy HTTPS proxy:

```sh
docker compose -f compose.yaml -f compose.cloud.yaml up --build -d
docker compose exec schema-workspace node scripts/admin-user.js admin
```

4. Open `https://schema.yourdomain.com`, sign in, and configure AI Settings. The cloud override sets PUBLIC_URL automatically. Caddy obtains and renews certificates when DNS and ports are correct. If another proxy already owns ports 80/443, use that proxy instead and set PUBLIC_URL to the exact HTTPS origin in `.env` with the base compose file.
5. Test one staging WordPress page: connect, crawl, AI generate, preview, apply, verify, and undo. No schema writes happen merely by deploying the app.

## Deploying behind an existing Traefik proxy (e.g. dm-containers)

Some hosts already run a shared Traefik reverse proxy for multiple apps
(one `web` Docker network, Traefik owns ports 80/443, HTTPS/cert issuance
is centralized). On that kind of host, don't use `compose.cloud.yaml`
(it ships its own Caddy that would fight Traefik for ports 80/443).
Use `compose.traefik.yaml` instead:

1. On the host, create the app directory (e.g. `/root/containers/schema-generator/`)
   and copy this project into it (excluding `.env`, `data/`, `node_modules/`).
2. Add a DNS A record for the subdomain (e.g. `schema.datadeposit.xyz`)
   pointing at the host, matching the proxy status other records in the
   zone use.
3. Create `.env` from `.env.example` and set `APP_DOMAIN=schema.datadeposit.xyz`
   plus a strong permanent `APP_SECRET` (32+ chars, `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
   Leave `PUBLIC_URL` unset — the compose file derives it from `APP_DOMAIN`. Optionally
   also set `DASHBOARD_USER`/`DASHBOARD_PASSWORD` to bootstrap the administrator
   account on first start instead of running the interactive script below (see
   "Local account setup" above).
4. Confirm the external `web` network exists (`docker network inspect web`;
   it's created once by the proxy's own compose project, not by this app).
5. Bring it up:

   ```sh
   docker compose -f compose.traefik.yaml up -d --build
   ```

   If you didn't set `DASHBOARD_USER`/`DASHBOARD_PASSWORD` in `.env`, create the
   admin account now:

   ```sh
   docker compose -f compose.traefik.yaml exec schema-workspace node scripts/admin-user.js admin
   ```

6. Verify: `docker ps --filter name=schema-generator`, then
   `curl -I https://schema.datadeposit.xyz` once Let's Encrypt has had a
   minute to issue the cert.

`compose.traefik.yaml` never publishes a host port (Traefik owns 80/443
for every app on the box) and joins the container to the external `web`
network with Traefik v1 labels (`traefik.frontend.rule`, `traefik.port`),
not v2 syntax. If the proxy sits on the same `web` network as this app
and you want per-client login-throttling instead of one shared bucket for
all traffic through the proxy, set `TRUST_PROXY` in `.env` to that
proxy's container IP/CIDR on `web` — leave it unset otherwise.

## Security and persistence

- Passwords use salted scrypt hashes, not reversible encryption. Random session tokens are stored only as hashes server-side. Cookies are HttpOnly and SameSite=Strict, with Secure and a `__Host-` prefix on HTTPS. Sessions last eight hours and survive an app restart. Sign out revokes the current session; administrator reset revokes all sessions.
- Mutating authenticated requests require a CSRF token and the exact allowed Origin. Login also requires the allowed Origin. Browser fetch calls attach the CSRF token automatically. API clients must authenticate and supply the session cookie, Origin and CSRF token; Basic auth is not a bypass.
- Login attempts are limited to ten per client IP per 15 minutes, with at most two concurrent password checks. The in-memory limiter resets on restart. By default forwarded IP headers are NOT trusted: behind a proxy the limit is shared by that proxy's users. For per-client limiting, set TRUST_PROXY to the exact controlled proxy IP/CIDR and ensure clients cannot reach the application directly. Never trust arbitrary internet-supplied forwarded headers. Add proxy-level rate limiting or an identity-aware access gateway for stronger protection/MFA.
- `auth.json` lives beside `workspace.json` in the persistent data volume. Back up the volume and APP_SECRET securely. Treat backups as sensitive. Restore an existing deployment's full data volume with its original secret; do not copy only site records and generate a new key. A historical file-based `.workspace-key` installation needs deliberate key migration before setting APP_SECRET.
- Preserve named volumes during upgrades (`docker compose up --build -d`). Do not use `down -v` unless intentionally discarding data. Back up with the app stopped so JSON files form a consistent snapshot. Keep one app replica; file-based storage is not a shared distributed database.
- Only `/health` (minimal status), CSS and the static logo/favicon under `/img` are public. The app remains a trusted-admin tool with powerful network/WordPress access, not a hardened public signup service. It has no MFA or individual team roles. Do not share the administrator account with untrusted users.

## Checks and limitations

`npm test` includes login, API blocking, password hashing, session expiration/revocation, CSRF, origin rejection and login throttling tests. Local Docker checks do not certify your cloud firewall, DNS, certificates, backup restore, or Rank Math Pro configuration. Verify those on your chosen server before production use.
