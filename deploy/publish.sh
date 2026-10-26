#!/usr/bin/env bash
set -Eeuo pipefail
# Publish built frontend assets only. Do not change SSH, firewall, DNS or proxy settings.
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
base="/srv/nd-ai-studio"
files=(index.html styles.css app.js data.js catalog.json account.js account.css controls.js workspace.html workspace.css workspace.js workspace-drafts.js models.js models.css billing.js branding.css legal.css nd-logo.webp favicon.png favicon.ico policies.html terms.html privacy.html acceptable-use.html agent.html agent.js agent.css)
for file in "${files[@]}"; do
    [[ -f "$root/dist/$file" && ! -L "$root/dist/$file" ]] || { echo "Missing or unsafe build file: $file" >&2; exit 1; }
done
if [[ -e "$base/current" && ! -L "$base/current" ]]; then
    echo 'Refusing to replace an existing non-symlink current directory.' >&2
    exit 1
fi
install -d -m 0755 "$base/releases"
release="$(mktemp -d "$base/releases/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
chmod 0755 "$release"
for file in "${files[@]}"; do install -m 0644 "$root/dist/$file" "$release/$file"; done
link="$base/.current-$(basename -- "$release")"
trap 'rm -f -- "$link"' EXIT
ln -s -- "$release" "$link"
mv -Tf -- "$link" "$base/current"
printf 'Published frontend assets to %s\n' "$release"
printf 'Previous releases retained. DNS, HTTPS and web server configuration were not changed.\n'
