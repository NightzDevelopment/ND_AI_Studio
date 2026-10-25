# Deploy the frontend at ai.nightz.dev

This deploys the frontend preview only. It does not install an AI backend or mark tools as available. No SSH credentials belong in this repository.

## Preconditions

Before changing the server, inspect its operating system, running services, listening ports, existing virtual hosts and firewall. Do not replace another application's proxy configuration or stop services to free ports.

The supplied `Caddyfile` is one site block, not a replacement for an existing configuration. Use it with Caddy 2 on a server whose web-server arrangement has been checked. An existing Nginx or Apache installation should serve the same release directory through its own dedicated virtual host instead of running a conflicting second server.

The intended DNS record is an `A` record named `ai` pointing to the chosen VPS. An AAAA record must only be present when the VPS has working, correctly routed IPv6. Confirm the authoritative DNS and current records before changing them.

Caddy's standard automatic HTTPS flow requires the domain to resolve to the server, public access to ports 80 and 443, permission to bind those ports, and writable persistent certificate storage. See the official documentation:

- https://caddyserver.com/docs/automatic-https
- https://caddyserver.com/docs/caddyfile/directives/file_server

## Build

In the checked-out repository with Node.js 22 or newer:

```bash
npm test
npm run build
```

Only the approved frontend assets are written to `dist`. The repository, docs, credentials and source control files must never be used as the public document root.

## Publish assets

After reviewing the script, run it with permission to write `/srv/nd-ai-studio`:

```bash
sudo bash deploy/publish.sh
```

It copies only the approved frontend assets into a new immutable release directory and atomically changes `/srv/nd-ai-studio/current`. It retains previous releases. It does not change DNS, SSH, firewall settings, certificates or proxy configuration. It refuses to replace a regular `current` directory.

## Configure the site

Review `deploy/Caddyfile`. Add that dedicated site block to the existing Caddy configuration or its existing import arrangement without overwriting other sites. Then validate the complete configuration before reloading:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Those commands assume Caddy is already installed as a system service and uses that configuration path. Inspect the actual service first. Installation and system-level changes are intentionally not automated.

The configured document root is `/srv/nd-ai-studio/current`. Directory browsing is not enabled. The site applies a self-origin content security policy and does not load third-party assets or scripts.

## Verify

```bash
curl -I https://ai.nightz.dev/
curl -fsS https://ai.nightz.dev/catalog.json
```

Confirm HTTPS, all 24 planned tools, search, filters, dialogs, keyboard focus, mobile layout and brief save/reload/edit/export/delete. Check that `/.env`, `/.git/config` and `/README.md` are not served. Test browser storage failure and invalid stored data without losing any existing briefs.

The local preview server is development tooling, not the production service. Do not expose its port publicly.

## Rollback

Select an existing, verified release directory under `/srv/nd-ai-studio/releases`, make a new temporary symlink to it, and atomically replace the `current` symlink. Do not copy over the live directory or delete the previous release during deployment. A proxy reload is not required for a document-root symlink change.

## Deployment status

These files prepare a deployment. They do not establish that a VPS was modified, DNS was changed, a certificate was issued or the domain is live.
