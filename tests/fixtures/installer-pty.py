"""Exercise the real installer Python blocks with piped stdin and a controlling PTY.

Only temporary environment files are used. No Docker, systemd, Nginx, provider
or production configuration is accessed. All credentials below are test data.
"""
import errno
import fcntl
import os
import pty
import re
import select
import signal
import stat
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(sys.argv[1])
CASE = sys.argv[2]
OWNER = '123456789012345678'
BOT = 'test-only-bot-token-' + 'a' * 40
WORKER = 'b' * 64
PROVIDER = 'sk-test-only-not-a-provider-key-' + 'c' * 32
OWNER_PROMPT = 'Your personal Discord USER ID (not the OAuth application ID): '
BOT_PROMPT = 'Discord bot token for role checks (hidden, blank skips): '
WORKER_PROMPT = 'Studio worker token from the website private environment (hidden): '
PROVIDER_PROMPT = 'OpenAI API key for this worker (hidden): '


def run_terminal(source, env, steps):
    master, slave = pty.openpty()
    before = termios.tcgetattr(master)[3]

    def attach():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    process = None
    output = bytearray()
    index = 0
    try:
        process = subprocess.Popen([sys.executable, '-', str(ROOT)], stdin=subprocess.PIPE,
                                   stdout=slave, stderr=slave, env=env, preexec_fn=attach)
        os.close(slave)
        slave = None
        process.stdin.write(source.encode())
        process.stdin.close()
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
                if not chunk:
                    break
                output.extend(chunk)
            if index < len(steps) and steps[index][0].encode() in output:
                prompt, value, hidden = steps[index]
                if hidden:
                    assert not (termios.tcgetattr(master)[3] & termios.ECHO), 'Secret entry has terminal echo enabled.'
                os.write(master, value.encode())
                index += 1
            if process.poll() is not None and not select.select([master], [], [], 0)[0]:
                break
        if process.poll() is None:
            process.wait(timeout=1)
        assert index == len(steps), 'Expected prompt was not reached: ' + output.decode(errors='replace')
        assert (termios.tcgetattr(master)[3] & termios.ECHO) == (before & termios.ECHO), 'Terminal echo was not restored.'
        return process.returncode, output.decode(errors='replace')
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        os.close(master)
        if slave is not None:
            os.close(slave)


def main():
    kind = 'studio' if CASE.startswith('studio-') else 'worker'
    script = (ROOT / 'deploy' / ('setup-' + kind + '.sh')).read_text()
    blocks = re.findall(r"^python3[^\n]* <<'PY'\n(.*?)^PY$", script, flags=re.M | re.S)
    assert len(blocks) == 1, 'Expected the actual embedded installer Python block.'
    source = blocks[0]
    with tempfile.TemporaryDirectory(prefix='nd-install-tty-') as temporary:
        home = Path(temporary)
        (home / '.config').mkdir()
        path = home / ('studio.env' if kind == 'studio' else '.config/nd-ai-worker.env')
        source = source.replace("Path('/etc/nd-ai-studio.env')", 'Path(' + repr(str(path)) + ')')
        # Exercise the root-only Studio block as the test runner's UID in a temp directory.
        source = source.replace('path.stat().st_uid != 0', 'path.stat().st_uid != os.getuid()')
        initial = ('APP_ORIGIN=https://ai.nightz.dev\nPORT=3081\n'
                   'DATABASE_PATH=/var/lib/nd-ai-studio/studio.sqlite\n'
                   'DISCORD_CLIENT_ID=223456789012345678\n'
                   'DISCORD_CLIENT_SECRET=test-only-oauth-secret\n') if kind == 'studio' else 'STUDIO_ORIGIN=https://ai.nightz.dev\n'
        steps = []
        success = True
        no_terminal = False
        expected_bot = BOT
        if CASE == 'studio-interactive':
            steps = [(OWNER_PROMPT, OWNER + '\n', False), (BOT_PROMPT, BOT + '\n', True)]
        elif CASE == 'studio-skip-bot':
            steps = [(OWNER_PROMPT, OWNER + '\n', False), (BOT_PROMPT, '\n', True)]
            expected_bot = ''
        elif CASE == 'studio-existing-owner':
            initial += 'OWNER_DISCORD_IDS=' + OWNER + '\nSTUDIO_WORKER_TOKEN=' + WORKER + '\n'
            steps = [(BOT_PROMPT, BOT + '\n', True)]
        elif CASE == 'studio-saved':
            initial += 'OWNER_DISCORD_IDS=' + OWNER + '\nDISCORD_BOT_TOKEN=' + BOT + '\nSTUDIO_WORKER_TOKEN=' + WORKER + '\n'
            no_terminal = True
        elif CASE == 'studio-no-terminal':
            no_terminal = True
            success = False
        elif CASE == 'studio-cancel':
            steps = [(OWNER_PROMPT, OWNER + '\n', False), (BOT_PROMPT, '\x03', True)]
            success = False
        elif CASE == 'studio-invalid-owner':
            steps = [(OWNER_PROMPT, 'not-a-discord-id\n', False), (BOT_PROMPT, '\n', True)]
            success = False
        elif CASE == 'worker-interactive':
            steps = [(WORKER_PROMPT, WORKER + '\n', True), (PROVIDER_PROMPT, PROVIDER + '\n', True)]
        elif CASE == 'worker-existing-token':
            initial += 'STUDIO_WORKER_TOKEN=' + WORKER + '\n'
            steps = [(PROVIDER_PROMPT, PROVIDER + '\n', True)]
        elif CASE == 'worker-saved':
            initial += 'STUDIO_WORKER_TOKEN=' + WORKER + '\nOPENAI_API_KEY=' + PROVIDER + '\n'
            no_terminal = True
        elif CASE == 'worker-no-terminal':
            no_terminal = True
            success = False
        elif CASE == 'worker-cancel':
            steps = [(WORKER_PROMPT, WORKER + '\n', True), (PROVIDER_PROMPT, '\x03', True)]
            success = False
        else:
            raise AssertionError('Unknown test case.')
        path.write_text(initial)
        path.chmod(0o600)
        env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'LANG': 'C.UTF-8',
               'ND_AI_VALIDATOR_IMAGE': 'sha256:' + 'd' * 64, 'DOCKER_HOST': 'unix:///test-only/docker.sock'}
        if no_terminal:
            result = subprocess.run([sys.executable, '-', str(ROOT)], input=source, env=env,
                                    text=True, capture_output=True, start_new_session=True, timeout=8)
            code, output = result.returncode, result.stdout + result.stderr
        else:
            code, output = run_terminal(source, env, steps)
        assert (code == 0) == success, output
        assert 'Traceback' not in output and 'not seekable' not in output, output
        for secret in (BOT, WORKER, PROVIDER, 'test-only-oauth-secret'):
            assert secret not in output, 'A test secret was printed or echoed.'
        backups = list(path.parent.glob('nd-ai-studio.env.backup-*' if kind == 'studio' else 'nd-ai-worker.env.backup-*'))
        assert not list(path.parent.glob('.nd-ai-*')), 'Staging files were not cleaned up.'
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        if not success:
            assert path.read_text() == initial, 'Failed setup changed the environment.'
            assert not backups, 'Failed prompt unexpectedly created a backup.'
            if no_terminal:
                assert 'interactive' in output.lower(), output
            return
        assert len(backups) == 1 and backups[0].read_text() == initial
        assert stat.S_IMODE(backups[0].stat().st_mode) == 0o600
        values = dict(line.split('=', 1) for line in path.read_text().splitlines())
        if kind == 'studio':
            for line in initial.splitlines():
                key, value = line.split('=', 1)
                assert values[key] == value, 'An existing setting was replaced.'
            assert values['OWNER_DISCORD_IDS'] == OWNER
            assert values['DISCORD_BOT_TOKEN'] == expected_bot
            assert re.fullmatch(r'[a-f0-9]{64}', values['STUDIO_WORKER_TOKEN'])
        else:
            assert values['STUDIO_WORKER_TOKEN'] == WORKER
            assert values['OPENAI_API_KEY'] == PROVIDER
            assert values['VALIDATOR_IMAGE'] == env['ND_AI_VALIDATOR_IMAGE']
            assert values['DOCKER_HOST'] == env['DOCKER_HOST']


if __name__ == '__main__':
    main()
