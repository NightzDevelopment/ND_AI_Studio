# Account deployment readiness

## HTTPS 404 immediately after an Nginx reload

The original installer polled the loopback API during startup, but made only one HTTPS request immediately after reloading Nginx. A successful reload command does not mean new workers have started accepting requests. An old worker can still return the previous static site's 404 during that transition. See https://docs.nginx.com/nginx-ingress-controller/overview/design/ for Nginx's reload/readiness behavior.

A 404 alone does not prove a reload race. An incorrect virtual host or missing proxy route can also return 404. The installer now checks readiness within a bounded 30-second deadline per phase, rather than ignoring failures or using a fixed sleep:

1. The loopback API must return JSON with `ok: true` and the repository's application version.
2. The HTTPS API must return the same health response and a configured anonymous session. A callback request without state must reach the expected rejected-flow handler, without contacting Discord.
3. Only after the API/auth routes are ready is the frontend published. All eight published files must then match the local build bytes.

Probes connect only to loopback, preserve the intended Host and TLS SNI, validate the certificate normally, use fresh connections, limit response sizes, and never follow redirects or print response bodies. An HTML fallback with status 200 is not a successful API health check.

Persistent failures still trigger rollback. The error reports the phase and failing route. The backup directory retains `failed-site` and, when present, `failed-snippet` for inspection before restoring the previous configuration. The installer does not print the environment file, cookies, OAuth credentials or authorization codes. It no longer tries to stop a first-install service after that service has already been removed during rollback.

The preflight rejects duplicate `ai.nightz.dev` server-name warnings. A warning naming `cloud.nightz.dev` is a separate configuration issue; this deployment does not rewrite those other virtual hosts.

## Retry after a rollback

The existing `/etc/nd-ai-studio.env` and account database are retained. Do not delete them or request another certificate just to retry.

```bash
cd /opt/nd-ai-studio
git status --short
git pull --ff-only origin main
bash deploy/setup-accounts.sh
```

Review any local changes instead of discarding them. The normal test command automatically includes the deployment regression tests. The installer reuses the saved OAuth credentials when the environment file exists.

## Discord credentials

Basic sign-in uses `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and the registered callback derived from `APP_ORIGIN`. It does not use a Discord bot token. A health check or `configured: true` confirms service/configuration readiness, not acceptance of credentials by Discord. Verify a real sign-in after deployment.

Bot-backed role synchronization, role assignment or guild automation would be a separate feature with its own server-side credentials and permissions. Adding a bot token to the environment alone does not implement that behavior.

Discord reference: https://docs.discord.com/developers/topics/oauth2
