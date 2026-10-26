# Implementation roadmap

## Current deliverable

Release 0.3 includes Discord accounts and private briefs, source projects and revision history, ZIP exports, owner/staff controls, and a configured worker path for the two coding generators. The overview highlights those two coding workflows; the searchable tool library retains all 24 definitions and labels the remaining 22 engines as planned. See the [README](../README.md) for current runtime configuration and deployment boundaries.

Local Chromium checks cover the account and source workflows against deterministic fixtures and the real local API/SQLite with mocked external integrations. These checks do not establish live provider access, rootless Docker enforcement or FiveM/Discord runtime correctness. Asset processing, customer payments, public sharing and the other catalog engines remain future work. The stages below describe the broader intended scope; they are not claims that every item is available.

## Stage 1: usable platform foundation

Build authentication, the responsive application shell, project storage, revision history, uploads, an authorized file browser, real job persistence, event streaming, cancellation, and artifact downloads.

Acceptance: a user can create a private project, upload permitted files, inspect revisions, reconnect to a real test job, cancel it, and retrieve an authorized artifact. One user must not access another user's files or logs. The directory must show planned tools honestly.

## Stage 2: coding workflows

Implement script generation and the standalone Discord bot target first. Add the FiveM bot target only after its runtime/dependency profile is verified. Add bounded repair loops, explicit validation results, diffs, and packaging. Then introduce framework conversion and supported resource merging.

Acceptance: supported sample projects have reproducible checks, no embedded secrets, complete files, dependency instructions, and accurately reported test coverage. Framework conversion must produce an unresolved-compatibility report when required rather than claiming perfect conversion.

## Stage 3: graphics workflows

Implement actual image generation and editing with versioned outputs, then inventory icons and texture-oriented tools using permitted templates and model-specific compatibility profiles.

Acceptance: exports preserve required dimensions, transparency, UV alignment where relevant, source history, and real target integration metadata.

## Stage 4: GTA asset workflows

Develop and validate the conversion pipeline before enabling text/image-to-prop promises. Add model import, placement tools, clothing workflows, weapons, and peds only as their export and validation paths pass the relevant test suite.

Acceptance: produced files are real target formats, required references resolve, and runtime test evidence is recorded for supported outputs. Unsupported source assets fail clearly with retained diagnostics.

## Stage 5: animation and sharing

Build a usable timeline/rig editor, motion import and retargeting, validated animation export, and scoped sharing. Add licensed model browsing, moderated community publishing, and released-script downloads.

Acceptance: supported animations play in the test environment; attribution survives import/export; private projects stay private until their owner publishes them.

## Release rule

A visible card is not a finished tool. A tool can be available only when its supported inputs, processing, error recovery, validation, outputs, and access controls are implemented and tested. Marketing text must not exceed verified behavior.
