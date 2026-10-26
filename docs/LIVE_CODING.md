# Live code preview and saved-source updates

The workspace shows generated file text while a supported provider sends it, and refreshes saved changes made in another tab. Neither path autosaves unsaved editor text.

## During a build

Use **View live code** beside the active build controls to reach the read-only preview. Its file selector shows proposed changes and deletions, the generation attempt and the saved revision used for the request. Received text is incomplete or unvalidated: previewing it never runs code, creates a saved revision, removes a saved file or settles credits.

OpenAI uses the Responses streaming interface and displays decoded file text as source deltas arrive. Reasoning text and raw provider events are not displayed. DeepSeek retains its verified non-streaming Responses contract; its candidate files can appear after the full response arrives. The interface states that distinction. No typing animation or simulated production code is used.

Validated completion still follows the existing [automatic-save flow](AUTOMATIC_BUILDS.md). A source conflict preserves the newer saved revision and finished ZIP. Local drafts remain separate and require comparison when their original saved content changed. Cancelled, failed, expired, archived or access-revoked builds cannot turn preview text into saved source. Terminal previews disappear; validated output is available through the ordinary editor, comparison and ZIP actions.

## Saved edits in another tab

Project polling includes the current saved revision even when the project has no builds. A newer revision refreshes the source explorer and saved content. An unchanged selected file keeps its cursor, selection and scroll position. A local draft keeps its original base and text; conflicting remote edits show the existing explicit recovery comparison.

Use **Check for updates** to request a fresh read. Automatic reads pause while offline or the page is hidden. Active builds check approximately every two seconds; idle projects approximately every four seconds. This synchronizes saved revisions, not another tab's private unsaved keystrokes. Failed reads retain existing source/drafts and show a retry state. Reconnect and tab visibility also trigger recovery reads without replaying writes.

## Worker and API behavior

The worker publishes only the latest bounded snapshot, at most once per second, using its current job lease. The API accepts up to 64 safe paths, 64 KiB per file and 128 KiB of text in total. Partial paths, unsafe paths, unsupported files and malformed changes are not accepted. Browser rendering uses text, never generated HTML execution.

Preview state is stored separately from canonical source in additive job columns and exposed only to that job's account. Summaries contain a version counter; detailed authorized reads contain the current candidate text. Snapshots do not renew leases, create ordinary build events, update project revisions or change spending/credits. Stale snapshots are acknowledged without replacing newer state. Terminal processing clears snapshots; reads also mask inaccessible, archived or expired previews.

Optional preview transport failures disable that channel without retrying the provider request or changing validated output. An active-lease/access rejection stops work through the existing cancellation path. Completion and usage remain authoritative: missing or uncertain provider usage retains the existing conservative reservation. A stream interruption never authorizes another paid request.

## Upgrade and verification

Upgrade the API, frontend and worker through the existing approved deployment process. The worker installer already copies all `worker/*.mjs` files, including the new preview module. Old workers simply produce no preview. New workers tolerate an older API's missing preview endpoint; saved-source auto-sync metadata requires the new API. The **Check for updates** action remains an explicit fallback. No additional credentials, paid service, WebSocket service or customer billing system is required.

Regression tests exercise fragmented SSE/UTF-8, escapes, bounded partial JSON, final usage accounting, publication throttling/cancellation, ownership/lease/terminal rules and browser source/draft isolation. Real local HTTP/SQLite browser journeys use synthetic Discord identities, provider chunks and validator results. Live provider streaming and production rootless enforcement require separately approved acceptance testing; fixture success does not establish them.
