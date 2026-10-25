#!/usr/bin/env bash
set +x
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
for command in node npm python3 nginx systemctl curl ss; do command -v "$command" >/dev/null || { echo "Missing: $command" >&2; exit 1; }; done
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<16))process.exit(1)' || { echo 'Node 22.16 or newer is required.' >&2; exit 1; }
site=/etc/nginx/sites-available/ai.nightz.dev.conf
snippet=/etc/nginx/snippets/nd-ai-studio-api.conf
unit=/etc/systemd/system/nd-ai-studio.service
base=/srv/nd-ai-studio/backend
[[ -f "$site" && ! -L "$site" ]] || { echo 'Expected the existing ai.nightz.dev Nginx site file. Nothing changed.' >&2; exit 1; }
[[ -L /etc/nginx/sites-enabled/ai.nightz.dev.conf ]] || { echo 'Expected the existing enabled site symlink.' >&2; exit 1; }
[[ "$(readlink -f /etc/nginx/sites-enabled/ai.nightz.dev.conf)" == "$site" ]] || { echo 'Unexpected enabled site target.' >&2; exit 1; }
[[ ! -e "$base/current" || -L "$base/current" ]] || { echo 'Backend current path is not a symlink.' >&2; exit 1; }
if [[ -e "$unit" ]] && ! grep -Fq 'ExecStart=/usr/bin/node /srv/nd-ai-studio/backend/current/server/start.mjs' "$unit"; then
    echo 'An unrelated service already uses the nd-ai-studio name. Nothing changed.' >&2; exit 1
fi
if ! systemctl is-active --quiet nd-ai-studio.service && [[ -n "$(ss -H -ltn '( sport = :3081 )')" ]]; then
    echo 'Port 3081 is occupied by another service. Nothing changed.' >&2; exit 1
fi
nginx -t
npm test
npm run build
staged="$(mktemp)"
trap 'rm -f -- "$staged"' EXIT
python3 deploy/configure-nginx.py "$site" > "$staged"
if [[ ! -f /etc/nd-ai-studio.env ]]; then
    printf '\nRegister this Discord OAuth redirect before signing in:\nhttps://ai.nightz.dev/auth/discord/callback\n\n'
    read -r -p 'Discord OAuth client ID: ' client_id </dev/tty
    read -r -s -p 'Discord OAuth client secret (hidden): ' client_secret </dev/tty
    printf '\n'
    [[ "$client_id" =~ ^[0-9]{17,20}$ && "$client_secret" =~ ^[A-Za-z0-9_.-]{16,200}$ ]] || { echo 'Invalid OAuth credentials format. Nothing deployed.' >&2; exit 1; }
    (umask 077; printf 'APP_ORIGIN=https://ai.nightz.dev\nPORT=3081\nDATABASE_PATH=/var/lib/nd-ai-studio/studio.sqlite\nDISCORD_CLIENT_ID=%s\nDISCORD_CLIENT_SECRET=%s\n' "$client_id" "$client_secret" > /etc/nd-ai-studio.env)
    unset client_id client_secret
fi
chmod 0600 /etc/nd-ai-studio.env
for setting in 'APP_ORIGIN=https://ai.nightz.dev' 'PORT=3081' 'DATABASE_PATH=/var/lib/nd-ai-studio/studio.sqlite'; do
    grep -Fxq "$setting" /etc/nd-ai-studio.env || { echo 'Existing environment uses a different origin, port or database. Review it privately.' >&2; exit 1; }
done
node deploy/backup.mjs
backup_dir="$(mktemp -d /root/nd-ai-accounts-deploy.XXXXXX)"
cp -a "$site" "$backup_dir/site"
[[ ! -e "$snippet" ]] || cp -a "$snippet" "$backup_dir/snippet"
[[ ! -e "$unit" ]] || cp -a "$unit" "$backup_dir/unit"
old_backend="$(readlink "$base/current" 2>/dev/null || true)"
old_frontend="$(readlink /srv/nd-ai-studio/current 2>/dev/null || true)"
active_before=0
systemctl is-active --quiet nd-ai-studio.service && active_before=1
replace_link() { local target="$1" link="$2"; ln -s -- "$target" "$link.next-$$"; mv -Tf -- "$link.next-$$" "$link"; }
rollback() {
    local code=$?
    trap - ERR
    set +e
    cp -a "$backup_dir/site" "$site"
    if [[ -e "$backup_dir/snippet" ]]; then cp -a "$backup_dir/snippet" "$snippet"; else rm -f "$snippet"; fi
    if [[ -e "$backup_dir/unit" ]]; then cp -a "$backup_dir/unit" "$unit"; else systemctl disable --now nd-ai-studio.service; rm -f "$unit"; fi
    if [[ -n "$old_backend" ]]; then replace_link "$old_backend" "$base/current"; else rm -f "$base/current"; fi
    if [[ -n "$old_frontend" ]]; then replace_link "$old_frontend" /srv/nd-ai-studio/current; fi
    systemctl daemon-reload
    if [[ $active_before -eq 1 ]]; then systemctl restart nd-ai-studio.service; else systemctl stop nd-ai-studio.service; fi
    nginx -t && systemctl reload nginx
    printf '\nDeployment stopped. Prior configuration restored. Backup: %s\n' "$backup_dir" >&2
    exit "$code"
}
trap rollback ERR
install -d -m 0755 "$base/releases" /etc/nginx/snippets
release="$(mktemp -d "$base/releases/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
chmod 0755 "$release"
install -d -m 0755 "$release/server" "$release/config"
for file in server/*.mjs; do install -m 0644 "$file" "$release/server/"; done
install -m 0644 config/tools.json "$release/config/tools.json"
install -m 0644 deploy/nd-ai-studio.service "$unit"
replace_link "$release" "$base/current"
systemctl daemon-reload
systemctl enable nd-ai-studio.service
systemctl restart nd-ai-studio.service
healthy=0
for attempt in {1..15}; do
    if curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:3081/api/health > /dev/null; then healthy=1; break; fi
    sleep 1
done
[[ $healthy -eq 1 ]] || { echo 'Account service health check failed.' >&2; false; }
install -m 0644 deploy/nginx-api.conf "$snippet"
install -m 0644 "$staged" "$site"
nginx -t
systemctl reload nginx
bash deploy/publish.sh
curl --noproxy '*' -fsS --max-time 10 --resolve ai.nightz.dev:443:127.0.0.1 https://ai.nightz.dev/api/health
printf '\n'
curl --noproxy '*' -fsS --max-time 10 --resolve ai.nightz.dev:443:127.0.0.1 https://ai.nightz.dev/account.js > /dev/null
trap - ERR
printf '\nAccounts deployed. Visit https://ai.nightz.dev/#account\nBackup: %s\n' "$backup_dir"
