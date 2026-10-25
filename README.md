# ND AI Studio

Nightz Development's original FiveM creation workspace at `ai.nightz.dev`.

## Release 0.3: source workspaces and controlled generation

Studio now includes private source projects, an owner control room, Discord role mappings and a separate AI build worker. The existing Discord login, profiles and account briefs remain in place.

### Available in the application

- Explicit owner Discord user-ID allowlist, least-privilege staff permissions, bot/guild connection checks and role refresh.
- Account search, suspension, session revocation, per-account daily build and spending limits, audit history and tool access switches.
- Private project creation, brief-to-project setup, search, sorting, favorites and archival.
- Custom file explorer, tabbed source editor, syntax highlighting, unsaved-change protection, keyboard shortcuts and revision conflicts.
- Create, edit, rename and delete source files; inspect historical versions, restore safely and export real ZIP files.
- Desktop split-pane workspace and mobile Files/Editor/Build panels, using original HTML, modular JavaScript and custom CSS.

### Generation requires configuration

The Script Generator and Discord Bot Generator have a real Responses API and worker path: queue, conservative budget reservation, persistent events, syntax/packaging checks, bounded repair, cancellation and automatic saving as a new project revision. Successful builds populate the explorer and editor without another Apply click. Optional comparison, revision history, restore and ZIP exports remain available.

Automatic saving requires the project's saved revision to still match the build snapshot. A conflict or source-storage limit keeps the validated output available for comparison and download. Browser drafts remain separate from incoming saved source. See [automatic build completion](docs/AUTOMATIC_BUILDS.md) for the lifecycle, recovery and upgrade checks.

Both generators are disabled by default. They require a configured model and prices, private worker credentials, a healthy rootless Docker validator, and owner-selected access. The current owner test deployment uses a dedicated non-root worker account on the same VPS; that is process/account separation, not a separate physical host. Keep this deployment in Owner testing. Use a separate build host before wider untrusted use. No generated source executes in the account API. Validation is not an FXServer or Discord runtime test.

The remaining 22 catalog engines are still planned. There is no billing, public gallery, paid-credit system, 3D generation, animation export or shared Nightz store session in this release. No fake credits, progress events or activity records are used.

## Deploy

Full instructions and security boundaries are in [deploy/STUDIO.md](deploy/STUDIO.md).

On the existing website VPS:

```bash
cd /home/nd-ai-studio
git pull --ff-only origin main
bash deploy/setup-studio.sh
```

The installer privately asks for the owner's personal Discord user ID and optional bot token, preserves OAuth credentials, and reuses the existing account deployment and rollback path. It does not install a worker on the production website VPS. A first account installation still uses [deploy/ACCOUNTS.md](deploy/ACCOUNTS.md).

Open `/workspace.html#projects` after normal Discord sign-in. Allowlisted owners can open `/workspace.html#admin`.

## Runtime and tests

Node.js 22.16 or newer. The application has no npm dependencies.

```bash
npm test
npm run build
npm start
```

`npm start` is a static local preview. Account and workspace APIs require `npm run start:api` behind the same-origin proxy. Production uses the supplied systemd and Nginx deployment, not the development preview.

The generation worker uses `npm run start:worker` with its private environment and pinned rootless validator. Follow the worker instructions before starting it; the website and worker releases must both be upgraded for automatic completion recovery.

Tests cover existing accounts, deployment readiness, ownership, CSRF, revisions, unsafe source paths, permission boundaries, spending reservations, worker leases, cancellation, provider response validation and container invocation constraints. Provider/Docker fixtures are not proof of live provider success or container enforcement. Complete a live acceptance test before making generation available to members.

## Existing account behavior

Discord OAuth requests only `identify`, uses browser-bound single-use state and PKCE, and stores hashed server session tokens. Discord access/refresh tokens are not stored. Profiles include an editable display name, bio, default framework and layout density. Account briefs support search, sorting, editing, export and optional idempotent import of local drafts.

Studio does not share the Nightz website's database, sessions, purchases, licenses, membership benefits or staff permissions. No website or existing bot repository was modified.

## Data locations

- Private API configuration: `/etc/nd-ai-studio.env`, root-owned mode 0600.
- Accounts, projects, revisions and job state: `/var/lib/nd-ai-studio/studio.sqlite`.
- Account API: `nd-ai-studio.service`, dynamic non-root user, localhost port 3081.
- Public assets: `/srv/nd-ai-studio/current`.
- Backend release pointers: `/srv/nd-ai-studio/backend/current`.
- Private worker configuration, under the dedicated worker account: `~/.config/nd-ai-worker.env`.

SQLite uses WAL, foreign keys, parameterized queries and transactions. Node's SQLite API is experimental on the tested Node 22 runtime. This is a bounded single-server database and one logical build worker, not a distributed multi-node service.

The database stays outside all public directories. Keep encrypted off-host backups, monitor disk usage, and use the SQLite backup API. Deployment snapshots alone are not a complete backup strategy.

## Source layout

- `web/`: original frontend, account controls and source workspace.
- `server/`: OAuth/account API, Studio permissions, source storage and job coordination.
- `worker/`: Responses provider adapter and trusted offline validator.
- `config/tools.json`: 24-tool roadmap catalog. Actual access to the two implemented generators is controlled by private server settings.
- `tests/`: regression tests; no production test-login endpoint.
- `scripts/`: asset build and local static preview.
- `deploy/`: bounded readiness checks, backups, Nginx integration and setup scripts.
- `docs/`: initial design, scope and longer-term architecture proposals.
- `assets/design/`: illustrative concept artwork, not an actual product screenshot.

## Security and licensing

Never commit API keys, Discord tokens, SSH credentials, customer uploads or databases. Do not put secrets in project files, prompts or browser fields. Bot and worker credentials are separate from OAuth. The first registered account never becomes an owner automatically.

No open-source license has been selected. Third-party assets require their own permission, provenance and attribution. The older concept image contains illustrative credit balances and projects which are not implemented product claims.
