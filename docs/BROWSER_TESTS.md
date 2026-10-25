# Browser test prerequisites

`tests/workspace-browser.py` runs the real built frontend against local deterministic HTTP fixtures. It does not sign in to Discord, use production accounts, contact a model provider or inspect a live deployment. These are development checks, separate from the API/worker service requirements and deployment readiness probes. Prefer a development or cloud environment for them.

`ModuleNotFoundError: No module named 'playwright'` means the Python interpreter used for that command does not have the test dependency. A successful Node test run and running worker service are not undone by this separate test-tool error. No production service restart or redeployment is needed to install the browser test tools.

## Isolated setup

Enter the repository checkout, then run as an ordinary user:

```bash
python3 -m venv "$HOME/.venvs/nd-ai-studio-browser"
"$HOME/.venvs/nd-ai-studio-browser/bin/python" -m pip install -r tests/browser-requirements.txt
"$HOME/.venvs/nd-ai-studio-browser/bin/python" -m playwright install chromium
npm run build
"$HOME/.venvs/nd-ai-studio-browser/bin/python" tests/workspace-browser.py
```

Use that environment's Python for subsequent test runs. Installing Playwright in the virtual environment does not make it available to a separate `python3` interpreter. No global pip installation or `--break-system-packages` is needed. The virtual environment and downloaded browsers stay outside the checkout.

The runner uses `CHROMIUM_PATH` when supplied, then a system `chromium` or `chromium-browser` executable, otherwise Playwright's downloaded Chromium. When a working system Chromium is already available, its download step can be omitted. To select an explicit executable:

```bash
CHROMIUM_PATH=/path/to/chromium "$HOME/.venvs/nd-ai-studio-browser/bin/python" tests/workspace-browser.py
```

## Linux prerequisites

On Ubuntu, if virtual environment creation reports that ensurepip is unavailable, an administrator must install `python3-venv`. On a development machine's administrative shell:

```bash
apt-get update
apt-get install -y python3-venv
```

Chromium also requires Linux shared libraries. Playwright's browser download does not install those system packages. If startup reports missing libraries, use the [official Linux browser dependency instructions](https://playwright.dev/python/docs/browsers#install-system-dependencies) with that machine's administrator. Do not add sudo/root privileges to the production worker account for browser tests; run the fixture tests on a development machine instead when the required libraries are unavailable there.

Both the Python package and a browser must be available before these checks can run. A missing prerequisite exits unsuccessfully; it is not reported as a passed or skipped test run. Browser fixture success is distinct from a real owner build through the configured provider and rootless validator.
