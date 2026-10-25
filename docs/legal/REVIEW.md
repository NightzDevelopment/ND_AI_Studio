# ai.nightz.dev policy and branding review

## Status

The three documents are drafts for the owner to review, not effective agreements or a completed privacy notice. The user confirmed the trading name Nightz Development, solo operation and the ai.nightz.dev scope. Solo operation does not establish the exact legal contracting identity or jurisdiction.

The build produces policies.html, terms.html, privacy.html and acceptable-use.html. Every page says it is a draft, has no effective date and makes no claim of legal compliance. Existing login behavior is unchanged. There is no new consent cookie, agreement checkbox, acceptance record, marketing tag or tracker.

Policy text is authored in scripts/policies.mjs. scripts/site-pages.mjs applies shared logo, favicon, draft-navigation and disclosure markup to the existing HTML/account templates during the build. Exact markers make unexpected template changes fail instead of silently dropping disclosures. Only the published output gets the shared chrome; source templates remain otherwise untouched.

## Branding

The WebP logo and PNG/ICO favicons are resized exports of the logo supplied in this conversation. No generated substitute, remote asset host or reconstruction is used. Transparency is retained. The ICO contains 16, 32 and 48 pixel images. The overview, source workspace, account sign-in panel and policy pages use the same artwork. Account avatars are still the signed-in user's avatar or initials, not replaced by the brand.

## Facts checked against the application

- server/discord.mjs and server/config.mjs: Discord identify scope, browser-bound state, seven-day sessions, ten-minute sign-in binding, and no stored Discord access/refresh token.
- server/studio-discord.mjs: optional bot-backed lookup of the configured guild's member roles; not a request for every guild through OAuth.
- server/store.mjs and server/studio-domain.mjs: account data, briefs, versioned projects, jobs and audit records. Archival and current-file removal are not historical deletion.
- server/studio.mjs: private account routes, administrative metadata, build queue, estimated usage controls and automatic saving of validated output only while the saved project still matches the build snapshot. Conflicting output remains available for inspection/export; existing review proposals are retained.
- worker/provider.mjs: constrained provider-specific OpenAI/DeepSeek Responses endpoints, current project snapshot, prompt and optional diagnostics. The selected provider is disclosed before generation. store:false or a stateless response is not a verified account-wide zero-retention setting.
- web/account.js and server/app.mjs: profile/brief export; source ZIPs use separate project export routes. No self-service account deletion route was found.
- web/workspace.js and web/workspace-drafts.js: account/project-scoped source draft recovery in tab-local sessionStorage, with explicit resolution when incoming saved source conflicts. Drafts are not uploaded until saved.
- server/studio-models.mjs: owner-granted internal credits, reservations, ledger entries, charged completed output and pending holds for uncertain usage. Delivered output blocked from automatic saving by a revision/storage conflict retains the existing delivered-proposal credit treatment.
- No checkout, customer subscriptions, credit purchases or payment collection is implemented in the reviewed Studio release. Internal accounting does not establish a business decision that Studio must be free.

These checks describe source, not all VPS, worker, provider-dashboard or hosting practices. No live provider configuration was inspected.

## Confirmation required before final publication

| Subject | Missing confirmation |
| --- | --- |
| Identity and jurisdiction | Exact legal operator, operating country/state and any required public business address |
| Contact | One monitored public email can cover support and privacy; no address has been invented |
| Eligibility | Intended ages, regions, whether guild membership is required, teams/shared account rules |
| Commercial model | Free or paid launch; only for paid services: processor/merchant, renewals, credits, failed-build treatment, refunds, cancellation, taxes and invoicing |
| Content rights | Input processing grant approval, output commercial use/resale/modification, ND templates, third-party terms and installation limits |
| Providers | Actual hosting and worker hosts, regions, backups/storage, email, proxy/CDN, analytics and error monitoring |
| Access and uses | Who can inspect source/prompts/outputs and why; marketing, training or promotion uses, if any |
| Retention | Accounts, projects/revisions, jobs, prompts/outputs, audit/access logs, backups and provider-account controls |
| Deletion | Monitored request channel, identity verification, applicable rights, deletion scope, backups and realistic response/fulfillment process |
| Support and termination | Channels/hours, actual response/update commitments, appeal route, export and service-closure arrangements |
| Custom work | Only include if sold on ai.nightz.dev; deposits, milestones, revisions, acceptance and ownership must be separately approved |

Unknown answers are publication blockers, not blanks to fill with generic assumptions. Do not infer the legal jurisdiction from an IP address or personal location.

## Controls for a later finalized release

After approval and legal review, replace draft status with a revision/effective date. Add permanent footer links and an unchecked acceptance control for Terms and Acceptable Use at account creation. A privacy notice is information, not blanket consent for unrelated processing. Store the actual document revision, account and timestamp server-side. Bind any pre-login acceptance state to the OAuth flow and check it on the server; do not rely on a frontend checkbox or localStorage as evidence. Existing users need a deliberate, version-aware transition rather than a fabricated past acceptance.

Keep the source-snapshot disclosure next to generation. Evaluate cookie/marketing consent only against the tracking actually installed and applicable rules. Do not add a decorative consent banner that claims to control things it does not control.

Implement and test a real deletion process before promising deletion periods. A deployment backup alone is not a retention program. Final customer billing terms must match the implementation before payments are enabled.

## Legal review

Eligibility/minors, consumer rights, privacy notices and rights handling, international transfers, retention/deletion, contract formation, AI output rights, termination and any future liability or dispute provisions depend on the operator, users and jurisdictions. No arbitration clause, liability cap, automatic no-refund rule, governing-law selection or regulatory certification has been invented. These drafts are not a compliance finding or legal advice.

Official references checked on 25 October 2026:
- FTC, honor actual privacy promises: https://www.ftc.gov/business-guidance/resources/marketing-your-mobile-app-get-it-right-start
- OpenAI API data controls, account-specific exceptions and retention distinctions: https://developers.openai.com/api/docs/guides/your-data

The provider documentation is external context, not evidence of this account's dashboard settings. Recheck it when finalizing the notice.

## Deployment

Use the repository at /home/nd-ai-studio. Run npm test and npm run build before publishing through the existing deployment flow. The approved asset lists in deploy/publish.sh and deploy/verify-accounts.mjs include the drafts and logo files. No Nginx restart, environment change, billing activation or new AI worker is required for this frontend-only change.

Do not call the drafts finalized after deployment. They remain review copies until the unresolved facts and decisions above are supplied.
