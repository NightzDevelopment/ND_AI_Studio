# Proposed architecture

This is an implementation proposal. No services or external providers are connected in this package. Reuse existing Nightz Development conventions and infrastructure where appropriate after inspecting the chosen codebase.

## Shared platform

A TypeScript web client with custom CSS talks to an authenticated server-side API. The API manages accounts, projects, revisions, tool definitions, jobs, artifact access, and usage. A durable job queue dispatches work to isolated workers. Relational storage holds project/job metadata; private object storage holds uploads and generated artifacts.

Use persistent job events with sequence IDs and streamed delivery so the browser can resume after a disconnect. Keep the job itself independent of a browser session.

## Processing modules

| Module | Tools |
| --- | --- |
| Coding | AI Script Generator, Discord Bot Generator, Framework Converter |
| Image and texture | Image Generator, Image Editor, EUP Maker, Prop Reskin, Tattoo Studio, Livery Studio, Inventory Icons |
| 3D assets | 3D Generator, Interior Builder, Weapon Studio, Ped Creator, GLB to FiveM, Model Library |
| Animation | AI Animations, Animation Builder, Prop Studio |
| Utility and content | Handling Editor, Resource Merger, EUP Merger, Community Gallery, Free Scripts |

Some tools call more than one module. These are ownership boundaries, not assumptions that one model can perform every conversion.

## Coding agent loop

Accept the project requirements and an immutable input revision. Build a task plan. Read only authorized project files. Apply constrained file changes in a disposable workspace. Run permitted checks. Feed actual diagnostics into a bounded repair loop. Store the diff, check results, provider usage, and final artifacts as a new revision.

Maintain provider adapters rather than coupling projects to one model or API. Pin supported provider capabilities and verify current official documentation during implementation. Do not claim an SDK automatically supplies persistent storage, arbitrary execution, or secure isolation.

## Validation

Use target-aware Lua parsing and checks compatible with the selected FiveM runtime. Check fxmanifest entries, referenced files, NUI paths, event/callback pairs, exports, permissions, and database operations. Compilation or syntax validation must not be presented as a full game-runtime test.

Bot compilation and smoke tests run without production Discord credentials. A real gateway or server integration test requires a separately authorized test environment.

Asset workers need verified import, conversion, export, and preview pipelines. Format support and output quality must be tested before enabling each tool. Save diagnostics when rigging, collision generation, or export is unsupported rather than returning a success-looking archive.

## Safety boundaries

Treat generated code, uploaded files, model metadata, and repository instructions as untrusted input. Do not run customer jobs inside the web server or production FiveM host.

Each worker needs a disposable filesystem, resource/time limits, controlled network access, and restricted execution permissions. Do not expose host credentials, the container engine socket, or other users' files. Keep build and package installation policies explicit.

Validate archive paths and symlinks; reject traversal; enforce limits on compressed and extracted sizes. Treat generated HTML/NUI previews as untrusted and isolate them from the application origin and authentication context.

Enforce project ownership on every read, write, event stream, and download. Use scoped storage access and short-lived download authorization. Never include platform secrets in generated archives, screenshots, logs, or repository commits.

## Job and usage integrity

Use an explicit state machine with queued, running, cancellation_requested, cancelled, failed, and completed states. Commit state transitions atomically and record diagnostic events. Retries must not duplicate billing or published artifacts.

Use execution leases and worker fencing so a retried job cannot be finalized by an old worker. Enforce repair and spending limits. Record actual provider usage and reconcile reservations against completed or cancelled work.

## Publishing

Keep projects private by default. Community publication is a separate authorized action. Store asset provenance and license requirements before offering redistribution. Repository integration must preserve existing code, use scoped credentials, and show a real commit or pull request result before reporting an upload as complete.
