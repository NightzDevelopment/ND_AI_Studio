# Discord accounts on ai.nightz.dev

This upgrade is for the existing Ubuntu 24.04 VPS, Node 22.23.1, working Nginx site and issued certificate. It does not install Caddy, request another certificate, change DNS/firewall/SSH or touch other applications.

## 1. Discord application

In the Discord Developer Portal, open the application used for Studio sign-in. Under OAuth2, add the following redirect without deleting the website's existing redirects:

```text
https://ai.nightz.dev/auth/discord/callback
```

Use the OAuth client ID and client secret, not a bot token. Using a dedicated application limits credential sharing, but the website's existing application can also authorize the additional redirect. Website sessions, purchases and permissions are not shared by this release.

## 2. Deploy from the existing root terminal

```bash
cd /home/nd-ai-studio
git status --short
git pull --ff-only origin main
bash deploy/setup-accounts.sh
```

Do not discard local changes. The first run asks for the ID and a hidden secret through `/dev/tty`; later runs reuse `/etc/nd-ai-studio.env`. The file is root-readable only. The setup script never reads credentials from the website or prints them.

The setup performs tests/builds, checks the known HTTPS server block, snapshots an existing database using SQLite's backup API, installs a non-root systemd service, checks the API, patches only the Studio Nginx site, tests/reloads Nginx, then atomically publishes the frontend. On a detected deployment error it restores the preceding configuration and release pointers. Database migrations are additive; restore a database backup only during a planned maintenance window, not by copying over a live WAL database.

The script deliberately stops for a different Nginx layout, existing unrecognized API locations, an unexpected CSP, another service using port 3081, or a different environment origin/port/database. Review those conflicts rather than overwriting another service.

## 3. Verify

```bash
systemctl status nd-ai-studio.service --no-pager
curl --noproxy '*' -fsS http://127.0.0.1:3081/api/health
curl -fsS https://ai.nightz.dev/api/session
```

Before login, the session response should contain `configured: true`, `user: null`, and `csrf: null`. Open the My account page, complete Discord authorization, save a profile preference, create a brief, reload, and verify the data remains. Test sign-out as well. Use two separate Discord accounts to verify a brief is private.

The public health endpoint checks database access. It does not prove Discord credentials or the registered redirect are correct.

## Configuration

The installer writes these non-secret settings plus the privately entered OAuth credentials:

```text
APP_ORIGIN=https://ai.nightz.dev
PORT=3081
DATABASE_PATH=/var/lib/nd-ai-studio/studio.sqlite
```

`DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` are read server-side. `DISCORD_REDIRECT_URI` is intentionally derived from APP_ORIGIN to prevent a mismatch between authorization and token exchange.

For credential rotation, edit `/etc/nd-ai-studio.env` privately and restart only `nd-ai-studio.service`. Do not paste the contents into diagnostics or chat. Store/Discord bot credentials are not needed.

## Operations

```bash
journalctl -u nd-ai-studio.service -n 50 --no-pager
node /home/nd-ai-studio/deploy/backup.mjs
```

Application logs intentionally omit authorization codes, cookies, tokens and request bodies. The Nginx `/auth/` location does not log OAuth query strings. Encrypted off-host backup and a retention policy are still operational responsibilities; the deploy-time snapshot is local only. Routine backup scheduling is not installed automatically.

The database is outside all published directories. The systemd StateDirectory can be managed through a systemd private-state symlink. Do not change its owner or make it world-readable. An account API restart does not reset users, briefs or sessions.

## Scope

The existing browser-local briefs stay intact and import only when the user explicitly chooses Import browser briefs. A repeated import skips the same source IDs; it does not overwrite a previously imported account brief. Import batches are transactional, with progress retained if a later batch fails.

All generation tools remain planned. This release supplies authentication and account storage, not AI-generated scripts, asset workers, billing or public community accounts.

## References

- Discord OAuth2: https://docs.discord.com/developers/topics/oauth2
- Node SQLite: https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html
- WAI-ARIA combobox pattern: https://www.w3.org/WAI/ARIA/apg/patterns/combobox/
