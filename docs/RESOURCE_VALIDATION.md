# Resource packaging validation

Review baseline: `6a0afbb29c17d115aa6a6254634130544da23963`.

This change extends the existing offline validator. It does not alter automatic build completion, provider selection, source ownership, credit settlement, API keys, database schema, frontend files or the worker's isolation settings.

## Reproduced gaps

The previous inspector accepted `fx_version` and `game` text inside comments or unrelated strings, rejected supported parenthesized declarations and plural `games` metadata, did not check manifest file references, and accepted a local NUI page absent from the client packfile. Four regression cases failed against the original inspector before implementation.

Two additional baseline fixtures accepted an object as the `discord.js` dependency value and a string as the whole `scripts` field. These are now rejected as source packaging errors. The validator still does not install packages or execute npm commands.

## FiveM checks added

`worker/manifest.cjs` inspects literal metadata without evaluating Lua. It supports quoted and long-bracket strings, Lua escapes, comments, scalar calls with or without parentheses, literal lists, `games` declarations and documented `*` / `**` file patterns. Lua syntax remains the responsibility of the existing `luac5.4 -p` check.

- Literal `client_script`, `server_script`, `shared_script`, `file` and plural entries must refer to supplied local files. Wrong-case paths receive a case-sensitive filename hint.
- Local `ui_page` and `loadscreen` files must exist and belong to the statically known client packfile. Their query/fragment suffixes are excluded from the file lookup. Server scripts do not implicitly populate the client packfile.
- Literal `data_file` paths are checked for existence. `AUDIO_WAVEPACK` directories containing supplied files are recognized without pretending to validate audio formats.
- Parent traversal, absolute local paths and malformed external references receive source diagnostics. The analyzer uses only the provided file list, not filesystem resolution or network requests.
- Missing matches for a glob produce a warning, not a fabricated rule that every optional wildcard must match a file.
- External `@resource/file` references, remote UI pages, declared dependencies, unsupported patterns and dynamic/scoped metadata are explicitly marked unverified. No attempt is made to fetch them or execute manifest expressions.

This is a conservative lexical checker, not an interpreter or proof of all runtime metadata. Computed values, aliases, control flow, third-party resource availability, HTML/CSS imports, data-file semantics and game behavior still need runtime review. Do not describe a successful packaging check as a successful FiveM launch or a comprehensive security audit.

Source errors are returned before informational diagnostics within the existing 100-message limit, so long success/dependency lists do not hide the first useful repair error. The worker's existing bounded repair policy handles these source errors. Infrastructure failures retain their separate classification and do not authorize paid repairs.

## Discord package checks

`discord.js` must have a non-empty string declaration in a dependencies object. A supplied `scripts` field must be an object whose values are command strings. Empty optional command strings remain accepted. The existing forbidden installation lifecycle hooks and entry-file checks are retained. String specifications are not a claim that a dependency exists, is secure, can be installed or is compatible with the target server.

## Verification in this review

- The baseline `worker/check.cjs` and Dockerfile matched their Git blob hashes before edits.
- 96 focused regression cases passed on Node 22.16.0.
- Tests cover comment/string false positives, literal forms, escaped and long strings, newline conventions, scoped expressions, external references, traversal, case mismatches, globbing, NUI packaging, data-file paths, dependency/script shapes, diagnostic bounds and malformed text.
- JavaScript syntax integration tests use the real Node parser and prove a fixture's top-level file-writing code and npm lifecycle command are not executed.
- Manifest packaging tests supply a successful parser fixture to isolate lexical and packaging behavior. No real Lua executable or Docker daemon was available in this review environment. The Dockerfile and clean two-module packaging layout were checked, but an actual container build was not run.
- JavaScript syntax checks and patch whitespace checks passed.

The full application suite, browser suites, hosted CI, real rootless Docker validation, provider requests and live deployment are not claimed by these focused results. Run the existing complete suite before merging and the worker acceptance check before enabling wider use.

## Upgrade after merge

This is a worker-only change. Let active builds finish first. In the `nd-ai-worker` session:

```bash
cd /home/nd-ai-worker/nd-ai-studio
git status --short
git pull --ff-only origin main
npm test
bash deploy/setup-worker.sh
systemctl --user status nd-ai-worker.service --no-pager --full
```

Stop if unexpected local changes exist or tests fail. The installer must rebuild and pin the validator image because the Dockerfile now includes `manifest.cjs`. Restarting an old image does not install this change. Do not remove the non-root user, read-only mount, network restrictions, capability drops, resource limits or private staging parent.

No website restart, new credentials, environment changes or database migration is required by this patch itself. Deploy any unrelated pending website changes according to their own upgrade instructions.

## Primary references

- Cfx resource manifests and globbing: https://docs.fivem.net/docs/scripting-reference/resource-manifest/
- Cfx fullscreen NUI packfile requirements: https://docs.fivem.net/docs/scripting-manual/nui-development/full-screen-nui/
- Cfx loading screens: https://docs.fivem.net/docs/scripting-manual/nui-development/loading-screens/
- npm dependency and script declarations: https://docs.npmjs.com/cli/configuring-npm/package-json/
