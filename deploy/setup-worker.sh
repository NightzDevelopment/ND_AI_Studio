#!/usr/bin/env bash
set +x
set -Eeuo pipefail
[[ $EUID -ne 0 ]] || { echo 'Run as a dedicated non-root user on a separate build host, not as root on the website VPS.' >&2; exit 1; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
for command in node docker systemctl python3; do command -v "$command" >/dev/null || { echo "Missing prerequisite: $command" >&2; exit 1; }; done
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<16))process.exit(1)'
[[ -n "${XDG_RUNTIME_DIR:-}" && -S "$XDG_RUNTIME_DIR/docker.sock" ]] || { echo 'A local rootless Docker user service is required.' >&2; exit 1; }
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"
unset DOCKER_CONTEXT
systemctl --user show-environment >/dev/null
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
const info=JSON.parse(execFileSync('docker',['info','--format','{{json .}}'],{encoding:'utf8'}));
if (!info.SecurityOptions?.some(value=>value.includes('rootless')) || info.CgroupVersion!=='2' || info.CgroupDriver!=='systemd') throw new Error('Rootless Docker with cgroup v2/systemd resource enforcement is required.');
JS
unit="$HOME/.config/systemd/user/nd-ai-worker.service"
if [[ -e "$unit" ]] && ! grep -Fq 'Description=ND AI Studio isolated build worker' "$unit"; then
    echo 'An unrelated user service already uses this name.' >&2; exit 1
fi
base="$HOME/.local/share/nd-ai-worker"
[[ ! -e "$base/current" || -L "$base/current" ]] || { echo 'Unexpected worker current directory.' >&2; exit 1; }
backup="$(mktemp -d "${TMPDIR:-/tmp}/nd-ai-worker-before.XXXXXX")"
chmod 0700 "$backup"
[[ ! -e "$unit" ]] || cp -a "$unit" "$backup/unit"
[[ ! -e "$HOME/.config/nd-ai-worker.env" ]] || cp -a "$HOME/.config/nd-ai-worker.env" "$backup/environment"
old="$(readlink "$base/current" 2>/dev/null || true)"
active_before=0
systemctl --user is-active --quiet nd-ai-worker.service && active_before=1
install -d -m 0700 "$base/releases" "$HOME/.config/systemd/user"
release="$(mktemp -d "$base/releases/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
install -d -m 0700 "$release/worker" "$release/server"
for file in worker/*.mjs; do install -m 0600 "$file" "$release/worker/"; done
install -m 0600 server/studio-domain.mjs "$release/server/"
# Build trusted validators only. No user files, tokens or host sockets enter the image.
docker build --tag nd-ai-validator:local worker
image="$(docker image inspect nd-ai-validator:local --format '{{.Id}}')"
export ND_AI_VALIDATOR_IMAGE="$image"
node --input-type=module -e "import {validatorReady} from './worker/validate.mjs'; await validatorReady(process.env.ND_AI_VALIDATOR_IMAGE);"
python3 - <<'PY'
import getpass
import os
import re
import secrets
import shutil
import tempfile
from pathlib import Path
path = Path.home() / '.config/nd-ai-worker.env'
if path.is_symlink():
    raise SystemExit('Refusing a symlink environment file.')
values = {}
if path.exists():
    if path.stat().st_uid != os.getuid():
        raise SystemExit('Worker environment must belong to the current user.')
    for line in path.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            if key in values:
                raise SystemExit('Duplicate worker configuration keys.')
            values[key] = value.strip().strip('"\'')
values.setdefault('STUDIO_ORIGIN', 'https://ai.nightz.dev')
with open('/dev/tty', 'r+') as tty:
    if not values.get('STUDIO_WORKER_TOKEN'):
        values['STUDIO_WORKER_TOKEN'] = getpass.getpass('Studio worker token from the website private environment (hidden): ', stream=tty).strip()
    if not values.get('OPENAI_API_KEY'):
        values['OPENAI_API_KEY'] = getpass.getpass('OpenAI API key for this worker (hidden): ', stream=tty).strip()
if not re.fullmatch(r'[a-f0-9]{64}', values['STUDIO_WORKER_TOKEN']):
    raise SystemExit('Invalid worker token.')
if not re.fullmatch(r'[A-Za-z0-9_.-]{16,500}', values['OPENAI_API_KEY']):
    raise SystemExit('Invalid provider key format.')
if values['STUDIO_ORIGIN'] != 'https://ai.nightz.dev':
    raise SystemExit('This installer is scoped to ai.nightz.dev.')
values['VALIDATOR_IMAGE'] = os.environ['ND_AI_VALIDATOR_IMAGE']
values['DOCKER_HOST'] = os.environ['DOCKER_HOST']
values['NODE_ENV'] = 'production'
text = ''.join(key + '=' + values[key] + '\n' for key in ['STUDIO_ORIGIN','STUDIO_WORKER_TOKEN','OPENAI_API_KEY','VALIDATOR_IMAGE','DOCKER_HOST','NODE_ENV'])
fd, name = tempfile.mkstemp(dir=path.parent, prefix='.nd-ai-worker.')
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write(text)
        file.flush()
        os.fsync(file.fileno())
    if path.exists():
        backup = path.with_name(path.name + '.backup-' + secrets.token_hex(4))
        shutil.copy2(path, backup)
        os.chmod(backup, 0o600)
    os.replace(name, path)
finally:
    if os.path.exists(name): os.unlink(name)
PY
rollback() {
    local code=$?
    trap - ERR
    set +e
    systemctl --user stop nd-ai-worker.service
    if [[ -e "$backup/environment" ]]; then cp -a "$backup/environment" "$HOME/.config/nd-ai-worker.env"; fi
    if [[ -e "$backup/unit" ]]; then cp -a "$backup/unit" "$unit"; else systemctl --user disable nd-ai-worker.service; rm -f "$unit"; fi
    if [[ -n "$old" ]]; then ln -s "$old" "$base/.current-rollback-$$"; mv -Tf "$base/.current-rollback-$$" "$base/current"; else rm -f "$base/current"; fi
    systemctl --user daemon-reload
    if [[ $active_before -eq 1 ]]; then systemctl --user restart nd-ai-worker.service; fi
    printf 'Worker deployment failed. Previous release retained. Backup: %s\n' "$backup" >&2
    exit "$code"
}
trap rollback ERR
if [[ -e "$unit" ]]; then systemctl --user stop nd-ai-worker.service; fi
node --env-file="$HOME/.config/nd-ai-worker.env" deploy/verify-worker.mjs reset
ln -s "$release" "$base/.current-$$"
mv -Tf "$base/.current-$$" "$base/current"
node_path="$(command -v node)"
[[ "$node_path" =~ ^/[A-Za-z0-9_./-]+$ ]] || { echo 'Unsupported Node executable path.' >&2; false; }
cat > "$unit" <<UNIT
[Unit]
Description=ND AI Studio isolated build worker
After=docker.service
Requires=docker.service

[Service]
Type=simple
EnvironmentFile=%h/.config/nd-ai-worker.env
WorkingDirectory=%h/.local/share/nd-ai-worker/current
ExecStart=$node_path %h/.local/share/nd-ai-worker/current/worker/start.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
UMask=0077
NoNewPrivileges=yes
MemoryMax=512M
TasksMax=128
LimitNOFILE=1024

[Install]
WantedBy=default.target
UNIT
chmod 0600 "$unit"
systemctl --user daemon-reload
systemctl --user enable nd-ai-worker.service
systemctl --user restart nd-ai-worker.service
node --env-file="$HOME/.config/nd-ai-worker.env" deploy/verify-worker.mjs ready
systemctl --user is-active --quiet nd-ai-worker.service
trap - ERR
printf '\nWorker service started. Verify Control room reports a connected worker before enabling a tool.\n'
printf 'Enable user lingering through your server administrator to keep the user service running after logout.\n'
