# Studio v0.3: owner controls, source projects and controlled generation

This release extends the existing Node, SQLite, Nginx and vanilla JavaScript application. It does not replace the Nightz store, share its cookies, change its permissions, or modify the Discord bot's PostgreSQL/Redis containers.

## What is implemented

- Explicit owner Discord user-ID allowlist, bot-backed guild role mappings, separate administration permissions, user suspension, session revocation, daily build/spend limits, audit history and generator access controls.
- Private projects created from scratch or copied from saved briefs, a custom source editor with syntax highlighting and tabs, file creation/rename/delete, optimistic revisions, favorites, archival, historical comparison, restore and ZIP export.
- Script and Discord bot proposal generation using the OpenAI Responses API, persistent queue/events, polling-based live logs, cancellation, bounded repairs, conservative spending reservations and review-before-apply.
- A separate build worker, pinned local validator image and offline rootless-container syntax checks. Project source is never executed by the account API.

The other 22 tool engines are not implemented. All generation is disabled by default. A project can be edited and exported without a connected worker. No subscriptions, paid credits, public gallery, store entitlements or shared account system are added.

## Upgrade the existing website VPS

Run in the existing root SSH terminal:

```bash
cd /opt/nd-ai-studio
git status --short
git pull --ff-only origin main
bash deploy/setup-studio.sh
```

Do not discard local changes to make a pull succeed. This installer expects the v0.2 account environment to already exist. A fresh installation must first run `bash deploy/setup-accounts.sh` to configure OAuth.

The upgrade asks for your **personal Discord user ID**, not the application/client ID, and an optional bot token. Existing configured values are preserved. It generates a separate random worker credential and validates the private environment before installing it. OAuth client credentials and the registered callback do not change.

Private values remain in `/etc/nd-ai-studio.env`, root-owned mode 0600:

- `OWNER_DISCORD_IDS`: comma-separated personal Discord user IDs, at most ten. No first-registration administrator rule exists.
- `DISCORD_BOT_TOKEN`: optional bot credential for guild and role lookups. This is not the OAuth client secret.
- `STUDIO_WORKER_TOKEN`: generated 64-character random hex credential. Copy it privately to the dedicated worker, never into a project, browser field or repository.

The wrapper calls the existing tested account deployment path. It keeps database snapshots, immutable releases, Nginx backups, bounded backend/HTTPS checks, verified frontend hashes and rollback. Additive Studio tables leave the original account schema version intact for binary rollback. Failed application deployment does not delete newly entered environment values; the previous environment is separately backed up.

The production account service stays on `127.0.0.1:3081`. Existing `/api/` routing covers the new endpoints. Do not expose port 3081 or install a second reverse proxy.

Verify:

```bash
systemctl status nd-ai-studio.service --no-pager
curl --fail --silent --show-error https://ai.nightz.dev/api/health
```

The health version is `0.3.0`. Sign in normally, then open `/workspace.html#projects`. An allowlisted owner sees Control room at `/workspace.html#admin`.

## Discord roles

Install the configured bot in the intended guild. In Control room > Settings, save the guild ID, add role IDs and select the exact Studio permissions. Use Test connection after saving. No Administrator permission, message-reading intent, auto-join, moderation command, role assignment or Gateway process is added by this integration.

Reads may use a 60-second role snapshot. Privileged staff mutations recheck membership. Failed lookups remove elevated access, and an environment allowlist is the only way to become an owner. OAuth sign-in is independent of bot availability. Staff can read project metadata with `projects:read`; this does not expose other users' source files.

Revoking a user's sessions affects Studio only. Suspension blocks Studio sign-in and cancels active builds. Configured owners cannot be suspended through the UI. Every administrative mutation records its actor and target, and user/project enforcement requires a reason.

## Dedicated generation host

Use a separate Linux build host and a dedicated non-root account. Keep generation away from the website, customer data and existing Discord bot services. The worker needs Node 22.16 or newer, rootless Docker, cgroup v2, the systemd cgroup driver and a working rootless Docker user service. This release deliberately refuses rootful Docker and unpinned validator image tags.

Install those prerequisites using the official Docker rootless documentation. A server administrator must enable lingering for the worker account so its user service remains running after logout. Run `loginctl enable-linger` with the actual worker username from an administrative terminal, not with the website account's root credentials in a project.

Clone this repository on that build host, enter its directory and run as the dedicated non-root user:

```bash
bash deploy/setup-worker.sh
```

The installer builds the trusted validator from `worker/Dockerfile`, records its immutable image ID, asks privately for the shared Studio worker token and an OpenAI API key, and creates a user service. No user source enters the image build context. No project dependencies are installed or project entry points executed by the validator.

Worker configuration: `~/.config/nd-ai-worker.env`, mode 0600. Worker releases: `~/.local/share/nd-ai-worker/releases`. User service: `nd-ai-worker.service`.

```bash
systemctl --user status nd-ai-worker.service --no-pager
journalctl --user -u nd-ai-worker.service -n 40 --no-pager
```

The worker authenticates to the website over HTTPS. It receives only a claimed project's snapshot, instructions and non-secret generation settings. The website never receives the provider key. The worker receives neither account sessions nor the bot token. A worker token is privileged: it can claim queued source snapshots, so keep it private and rotate it on both hosts after exposure.

Do not mount a Docker socket, credentials, website directories or arbitrary host paths into validation containers. The validator mounts only a temporary source tree read-only, disables the network, drops capabilities, uses a non-root UID, and applies memory, PID, CPU and time limits. Containers are forcibly removed after checks, including timed-out Docker clients. Container isolation is not an absolute security guarantee; the separate host remains necessary.

## Enable owner testing

In Control room > Settings enter a Responses-compatible model identifier and its current input/output USD prices per million tokens. Prices are owner-supplied accounting assumptions, not automatic billing data. A missing model, zero price, disconnected worker, disabled tool or exhausted account budget prevents generation.

Start with the default two-call maximum and review the per-build budget. In Tools, change only AI Script Generator or Discord Bot Generator to **Owner testing**. Do not enable Members until you have tested actual outputs and reconciled provider billing.

The input estimate counts UTF-8 request bytes plus headroom and reserves configured maximum output tokens. Model-specific charges, price changes and unknown request outcomes can still differ from estimates. Use provider-side account spending controls as an additional guardrail. No usage purchase, subscription or credit charge is made by this application.

A job receives one active lease. Lost or expired leases are failed rather than automatically replayed, because the original provider request may already have been billed. Cancelling a running job stops future work when the worker detects it, but cannot retract a provider request already accepted. Unknown outcomes retain the full reservation. The UI labels this conservatively; do not describe it as an actual provider invoice.

Successful jobs produce proposals, not immediate project writes. Inspect the changed-file comparison, download it or apply it. Applying requires the same project revision used by the build. Concurrent manual changes are never silently replaced. Failed checks get at most one repair when the configured call limit and remaining budget permit it.

## Validation scope

JavaScript is checked using `node --check`, Lua using `luac5.4 -p`, and JSON is parsed. The validator checks basic package/manifest declarations and a README. FiveM generation uses standard Lua 5.4 and `GetHashKey` rather than Cfx-specific backtick syntax for this parser.

Not verified by these checks: FXServer natives, framework exports, network-event behavior, SQL behavior against a live database, NUI behavior, dependency installation, Discord Gateway authentication, slash-command deployment or bot boot. Output explicitly carries that limitation. Test resources in a controlled development server before production use.

## Bounds and operation

100 projects per account, 100 retained revisions per project, 64 text files, 64 KiB per file, 128 KiB source per snapshot and 32 MiB stored project source per account. Only approved text extensions are accepted; traversal, case collisions, file/directory collisions, actual `.env` files and binary content are rejected. Filename filtering is not a secret scanner: never paste credentials into source or build prompts.

The queue accepts 20 active jobs globally and one per account. Default accounts have five build attempts and a USD 1.00 budget per UTC day. The owner can change account limits. Build and audit history require normal disk monitoring and backup operations. Account, source and queue tables remain in the existing SQLite database; no Redis or distributed queue is claimed.

Back up the SQLite database through `deploy/backup.mjs`, not by copying a live WAL file. Keep encrypted off-host backups and monitor disk usage. No automated backup schedule or production rollout is performed by this repository update.

## Verification record

The release includes account, deployment, project, permission and worker regression tests. Worker tests stub the provider and Docker command runner. Browser fixture tests do not perform a real Discord login or provider call. Live Discord role access, rootless Docker/cgroup enforcement, provider billing, systemd installation and generation still require acceptance checks on the configured hosts.

## Primary references

- Discord OAuth2: https://docs.discord.com/developers/topics/oauth2
- Discord guild member API: https://docs.discord.com/developers/resources/guild#get-guild-member
- OpenAI structured outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- Docker rootless mode: https://docs.docker.com/engine/security/rootless/
- Docker rootless resource limits: https://docs.docker.com/engine/security/rootless/tips/
