#!/usr/bin/env bash
set +x
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run this website upgrade as root.' >&2; exit 1; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
[[ -f /etc/nd-ai-studio.env && ! -L /etc/nd-ai-studio.env ]] || {
    echo 'The account environment is missing. Run deploy/setup-accounts.sh first.' >&2
    exit 1
}
for command in python3 node npm; do command -v "$command" >/dev/null || exit 1; done
npm test
python3 - "$root" <<'PY'
import getpass
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import warnings
from datetime import datetime, timezone
from pathlib import Path
root = Path(sys.argv[1])
path = Path('/etc/nd-ai-studio.env')
if path.is_symlink() or path.stat().st_uid != 0:
    raise SystemExit('Environment file must be a root-owned regular file.')
text = path.read_text()
keys = ('OWNER_DISCORD_IDS', 'DISCORD_BOT_TOKEN', 'STUDIO_WORKER_TOKEN')
values = {}
for key in keys:
    matches = re.findall(r'^' + key + r'=(.*)$', text, flags=re.M)
    if len(matches) > 1:
        raise SystemExit('Duplicate Studio environment keys. Review the private environment before upgrading.')
    values[key] = matches[0].strip().strip('"\'') if matches else ''
if not values['OWNER_DISCORD_IDS'] or not values['DISCORD_BOT_TOKEN']:
    try:
        # Terminals are not seekable. Keep input and prompt output separate.
        with open('/dev/tty', 'r', encoding='utf-8') as tty_input, open('/dev/tty', 'w', encoding='utf-8') as tty:
            with warnings.catch_warnings():
                warnings.simplefilter('error', getpass.GetPassWarning)
                if not values['OWNER_DISCORD_IDS']:
                    tty.write('Your personal Discord USER ID (not the OAuth application ID): ')
                    tty.flush()
                    answer = tty_input.readline()
                    if not answer:
                        raise EOFError
                    values['OWNER_DISCORD_IDS'] = answer.strip()
                if not values['DISCORD_BOT_TOKEN']:
                    values['DISCORD_BOT_TOKEN'] = getpass.getpass('Discord bot token for role checks (hidden, blank skips): ', stream=tty).strip()
    except (OSError, EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        raise SystemExit('Secure interactive setup could not complete. Run this installer in your SSH terminal. Environment file unchanged.') from None
ids = values['OWNER_DISCORD_IDS'].split(',')
if not 1 <= len(ids) <= 10 or any(not re.fullmatch(r'\d{17,20}', value.strip()) for value in ids):
    raise SystemExit('Provide one to ten personal Discord user IDs, comma-separated.')
values['OWNER_DISCORD_IDS'] = ','.join(dict.fromkeys(value.strip() for value in ids))
if values['DISCORD_BOT_TOKEN'] and not re.fullmatch(r'[A-Za-z0-9_.-]{30,300}', values['DISCORD_BOT_TOKEN']):
    raise SystemExit('Invalid bot token format. Nothing changed.')
values['STUDIO_WORKER_TOKEN'] = values['STUDIO_WORKER_TOKEN'] or secrets.token_hex(32)
if not re.fullmatch(r'[a-f0-9]{64}', values['STUDIO_WORKER_TOKEN']):
    raise SystemExit('Invalid worker token. Nothing changed.')
for key, value in values.items():
    text = re.sub(r'^' + key + r'=.*\n?', '', text, flags=re.M)
    text = text.rstrip('\n') + '\n' + key + '=' + value + '\n'
fd, staging = tempfile.mkstemp(prefix='.nd-ai-studio.', dir=path.parent)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write(text)
        file.flush()
        os.fsync(file.fileno())
    result = subprocess.run(['node', '--env-file=' + staging, '--input-type=module', '-e', "import {readConfig} from './server/config.mjs'; readConfig();"], cwd=root, env={'PATH': os.environ['PATH'], 'NODE_ENV': 'production'}, capture_output=True)
    if result.returncode:
        raise SystemExit('Private configuration validation failed. No secrets were printed and no environment changes were installed.')
    backup = path.with_name('nd-ai-studio.env.backup-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(3))
    shutil.copy2(path, backup)
    os.chmod(backup, 0o600)
    os.replace(staging, path)
    print('Private owner and worker settings saved. Previous environment: ' + str(backup))
finally:
    if os.path.exists(staging):
        os.unlink(staging)
PY
bash deploy/setup-accounts.sh
printf '\nStudio v0.3 deployed. Open https://ai.nightz.dev/workspace.html#projects\n'
printf 'Owner controls: https://ai.nightz.dev/workspace.html#admin\n'
printf 'Generation stays disabled until the separate worker, model, prices and tool access are configured.\n'
