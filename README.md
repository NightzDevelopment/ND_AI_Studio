# ND AI Studio

Nightz Development's original FiveM creation workspace at `ai.nightz.dev`.

## Release 0.2: Discord accounts

Implemented:

- Server-side Discord authorization-code login with PKCE and browser-bound, single-use state.
- Private profiles with a Discord avatar, username, editable display name and bio.
- Saved default framework and comfortable/compact workspace density.
- Persistent, private account briefs with create/edit/delete, search, sorting and JSON export.
- Optional idempotent import of existing browser-local briefs. Browser originals are never deleted.
- Custom keyboard-operable dropdowns, an account menu and confirmation dialogs.
- Hashed server sessions, CSRF/origin checks, ownership checks, revision conflict protection and rate limits.
- Sign out, sign out everywhere, and account data export.
- A separate localhost API service and a scoped upgrade for the existing Nginx site.

All 24 generation/conversion/browsing tools remain planned and disabled. There is no AI generation, worker execution, billing, public profile directory or community publishing yet. A brief is requirements data, not a generated resource.

Discord login uses the same identity provider as the Nightz website, not a shared website session or shared store database. Store purchases, licenses, membership benefits and staff permissions are not imported. The website repository is unchanged.

## Runtime

Node.js 22.16 or newer. No npm dependencies or install step are required.

```bash
npm test
npm run build
npm start
```

`npm start` keeps the existing static development preview. Account features require `npm run start:api` behind a same-origin proxy. Production uses the supplied Nginx configuration and systemd service, not the development preview.

The account API uses Node's built-in `node:sqlite` with WAL, foreign keys, parameterized queries and transactional imports. The SQLite API is experimental on Node 22; the tested runtime is Node 22.16 and the target VPS already has Node 22.23.1. Keep a supported patched Node release and verify updates before rollout. This is a bounded, single-process account service, not the planned distributed generation backend. Future multi-node execution should use the separately planned shared data/queue infrastructure.

## Deploy accounts

See [the account deployment guide](deploy/ACCOUNTS.md). Register this exact additional OAuth redirect on the Discord application:

```text
https://ai.nightz.dev/auth/discord/callback
```

The installer prompts for the OAuth client ID and secret privately in the SSH terminal. Do not paste them into chat, a repository, project briefs or frontend code. A bot token is not needed.

```bash
cd /opt/nd-ai-studio
git pull --ff-only origin main
bash deploy/setup-accounts.sh
```

The installer expects the existing Ubuntu/Nginx layout and working certificate for `ai.nightz.dev`. It tests before publishing, snapshots an existing SQLite database, retains application releases and backs up the modified Nginx site and service files. Only the Studio virtual host gets new API routes and the Discord avatar image-source allowance. Other site files and the bot's PostgreSQL/Redis containers are not changed.

## Data and sessions

- Account data: `/var/lib/nd-ai-studio/studio.sqlite`, outside the web root and repository.
- Private configuration: `/etc/nd-ai-studio.env`, mode 0600.
- Service: `nd-ai-studio.service`, dynamic non-root user, bound to `127.0.0.1:3081`.
- Public assets: `/srv/nd-ai-studio/current`.
- Backend releases: `/srv/nd-ai-studio/backend/releases`.
- Sessions expire after seven days, with at most ten active sessions per user.
- Account limits: 100 briefs, 80-character names, 12,000-character requirements, 500-character bio.
- Guest briefs remain under `nd-ai-studio.briefs.v1` in browser storage. Import is opt-in and keeps local copies.

Profiles are private. Only the `identify` OAuth scope is requested. Discord access/refresh tokens are not stored. User passwords, email, guild lists and messages are not requested. The host-only session cookie is separate from the store's cookies.

## Verification

Automated tests cover OAuth state binding/replay/expiry, secure session cookies, CSRF, ownership, optimistic revisions, transactional imports, logout, input limits, database persistence and the existing catalog/storage behavior. Browser fixture checks cover profile saving against the real local API, guest and account briefs, custom keyboard dropdowns, confirmations, menus and responsive layouts. These use a seeded test identity, not a real Discord authorization.

Live Discord authorization, systemd installation and Nginx deployment must still be verified on the VPS after credentials are configured. No test fixture or test sign-in endpoint is included in the production service.

## Source layout

- `web/`: original semantic HTML, modular JavaScript and custom CSS.
- `server/`: account API, Discord OAuth adapter, configuration and SQLite store.
- `config/tools.json`: authoritative 24-tool catalog; all engines remain disabled.
- `tests/`: Node tests.
- `scripts/`: approved-asset build and static preview tooling.
- `deploy/`: deployment, backup, Nginx patch and systemd files.
- `docs/`: original design, product scope and proposed later platform architecture.
- `assets/design/`: illustrative concept artwork, not a product screenshot.

No UI frameworks, copied templates or generated fake build logs are used.

## Security and licensing

Never commit API keys, Discord tokens, SSH credentials, customer uploads or production databases. Run generated code only in a future isolated worker system, never in this account service.

No open-source license has been selected. Third-party assets need their own permissions, attribution and provenance.
