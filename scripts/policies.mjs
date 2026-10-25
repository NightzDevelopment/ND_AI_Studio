// Draft content only. Approval, contacts and operational facts are still outstanding.
export const POLICY_REVISION = '2026-10-25-draft-2';
export const policyDocuments = [
  {
    file: 'terms.html', title: 'Terms of Use', eyebrow: '01 / USING STUDIO',
    summary: 'Accounts, your content and the limits of the current service.',
    sections: [
      ['About Studio', ['Nightz AI Studio is operated under the Nightz Development name. These draft terms cover ai.nightz.dev only, not other Nightz websites or services.', 'Studio provides accounts and tools for creating, editing, storing and exporting source-code projects. AI generation is available only when the relevant tool is enabled and configured. Tools marked as planned are not available services or guaranteed future releases.']],
      ['Your account', ['Keep your Discord account secure. Use only accounts you are authorized to access. Do not impersonate another person, share access that bypasses restrictions, or attempt to access someone else\'s projects.']],
      ['Your content', ['Only submit code, files and other material you own or have permission to use. Keep passwords, API keys, bot tokens and confidential credentials out of prompts and project files.', 'You retain any rights you already hold in your submitted material. You authorize Nightz Development to store and process that material as needed to provide the Studio features you choose to use. This permission does not authorize unrelated resale or public distribution of your content.']],
      ['Review and keep your work', ['Successful validated builds normally save as a new project revision automatically. A newer saved revision or a source-storage limit can block automatic saving; finished output remains available for comparison and download.', 'Review and test code before using it on a live server. Saving source in Studio does not deploy or execute it. Check its security, dependencies and compatibility. Keep your own copies of important work. Automated checks do not replace testing in the intended environment.']],
      ['Misuse and restrictions', ['Nightz Development may restrict or suspend access when reasonably necessary to address misuse, security threats, unlawful activity or violations of these terms. Do not bypass access controls or generation limits. The AI & Acceptable Use draft explains the proposed usage rules.']],
      ['Availability and your rights', ['Features may change or become temporarily unavailable. These terms do not promise uninterrupted service, error-free results or compatibility with every framework or server.', 'Nothing in these terms excludes consumer rights or other protections that cannot legally be excluded.']]
    ],
    pending: 'The legal operator, contact details, eligible ages and regions, support commitments, suspension appeals, closure arrangements and output licensing still need confirmation. Pricing, refunds and subscription terms are not established by this draft.'
  },
  {
    file: 'privacy.html', title: 'Privacy Policy', eyebrow: '02 / YOUR INFORMATION',
    summary: 'What the application handles and what still needs confirmation.',
    sections: [
      ['Scope', ['This draft describes the reviewed Nightz AI Studio application at ai.nightz.dev. It does not describe Nightz Development\'s separate store or other services. Infrastructure providers and operational practices still need confirmation before this becomes a final privacy notice.']],
      ['Account information', ['Studio uses Discord sign-in. Account information includes your Discord user ID, username, avatar information and the display name, bio and preferences you choose to save. The sign-in integration does not request your Discord password or email address and does not retain Discord access or refresh tokens.', 'When a Studio bot and guild are configured, Studio may check your membership and roles in that guild for access permissions. This is separate from the basic Discord sign-in scope.']],
      ['Project and service information', ['Studio stores saved briefs, project details, source files and revision history. When generation is used, it also stores associated requests, results, build events and usage estimates. These records support your workspace, project history and build processing.', 'Account controls, role checks and privileged changes also create operational records. Request addresses are used for rate limiting. Web-server logs, infrastructure logs and their retention must be confirmed separately.']],
      ['Project privacy and operator access', ['Projects are private to their accounts through the application\'s normal project routes. The current release does not provide public community publishing.', 'Private does not mean inaccessible to the people operating the servers or providers processing a requested feature. Authorized administrative controls include account information and project metadata. The operator\'s actual staff-access practices and purposes still require confirmation.']],
      ['AI processing', ['When generation is enabled through the implemented OpenAI integration, the request includes your project details, generation instructions and the current project\'s source snapshot. Repair requests can also include validation diagnostics. It is not limited to the file currently open in the editor.', 'The integration sets store: false. That setting does not, by itself, mean the provider retains no data. Provider monitoring, model-specific behavior and account settings must also be considered. No zero-retention or account-specific training-setting promise is made in this draft.']],
      ['Cookies and browser storage', ['Studio uses the __Host-ndai-session cookie for authenticated sessions and the __Host-ndai-flow cookie to bind a Discord sign-in attempt to your browser. The reviewed application sets a seven-day session lifetime and a ten-minute sign-in-flow lifetime; sign-out or expiry can end access sooner.', 'Browser-local briefs use the nd-ai-studio.briefs.v1 storage key on the device where they were created. They remain until removed from that browser or its storage is cleared. Signing in does not automatically import them. Import is a separate action and keeps the browser copies.', 'Unsaved source drafts and their original saved content use account/project-scoped sessionStorage keys beginning ndai:source-drafts:. This keeps recovery copies in the current browser tab across reloads and project navigation. Recovery copies are removed when saved or explicitly discarded, and can also disappear when the tab closes or browser storage is cleared. If storage is unavailable, Studio warns that recovery across reloads is unavailable. Draft text is not uploaded until you save it.']],
      ['Revisions, exports and deletion', ['Changing or removing a file from the current revision does not erase older project snapshots. Archiving a project is not deletion.', 'The current account export contains the profile and saved briefs. Project source can be exported separately as ZIP files. The reviewed release does not have a self-service account-deletion control.', 'Retention periods for accounts, revisions, prompts, outputs, logs and backups, plus a working deletion-request contact and process, must be confirmed before this draft is finalized. No deletion deadline is promised here.']],
      ['Security', ['Implemented protections include access checks, hashed server-session tokens, request-origin and CSRF checks, revision conflict checks and private server-side configuration. These are application controls, not a guarantee that every hosting or operational security measure has been verified.']]
    ],
    pending: 'The legal operator and privacy contact, hosting and worker providers, processing regions, other third parties, staff-access rules, marketing or analytics use, retention periods, backup handling and deletion-request process remain unconfirmed.'
  },
  {
    file: 'acceptable-use.html', title: 'AI & Acceptable Use', eyebrow: '03 / BUILD RESPONSIBLY',
    summary: 'Review generated work, respect other people\'s rights and protect credentials.',
    sections: [
      ['Review AI-generated work', ['Validated output can be saved in Studio automatically. Review its security, behavior, dependencies and suitability before deployment. Automatic source saving is not permission to deploy or run output on a live server.', 'The current validation workflow is not a live FiveM server test or a Discord bot runtime test. Passing automated checks does not establish that a resource works correctly in your environment.']],
      ['Use material you are entitled to use', ['Do not submit stolen scripts, leaked resources, customer data without permission or other material you are not authorized to process. Respect third-party licenses. Generating, editing or exporting a file does not remove restrictions attached to included third-party material.']],
      ['Do not misuse Studio', ['Do not use Studio to steal credentials, distribute malware, compromise accounts or servers, harass others, or interfere with someone else\'s systems.', 'Do not attempt to escape validation environments, access internal services, impersonate staff, evade restrictions or deliberately exhaust service resources.']],
      ['Keep sensitive information out', ['Keep production credentials and confidential information out of prompts and project files. Use empty example configuration values instead. Generation can send the current project\'s source to the configured AI provider.']],
      ['Output rights and limits', ['These drafts do not promise that AI output is exclusive, original or free from third-party rights. They do not yet establish commercial-use, resale, redistribution or installation-license terms for generated output. Those decisions must be confirmed before final publication.', 'Account and build limits are technical controls. They do not, by themselves, establish purchased-credit, subscription or refund rules.']]
    ],
    pending: 'Output licensing, reporting and support contacts, customer pricing, refunds and treatment of failed or cancelled paid generations remain undecided. No payment or licensing policy is created by this draft.'
  }
];

const escape = text => text.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
export const policyLinks = '<nav class="policy-links" aria-label="Policy drafts"><a href="/terms.html">Terms draft</a><a href="/privacy.html">Privacy draft</a><a href="/acceptable-use.html">AI &amp; use draft</a></nav>';
export const policyNotice = '<div class="policy-disclosure"><p>Read the <a href="/policies.html">policy drafts</a> for ai.nightz.dev. They are under review, not active agreements. Signing in does not record acceptance of these drafts.</p></div>';
export const logo = '<img class="nd-brand-logo" src="/nd-logo.webp" width="48" height="48" alt="Nightz Development">';
export const brandHead = '  <link rel="icon" href="/favicon.ico?v=nd-20261025" sizes="16x16 32x32 48x48">\n  <link rel="icon" type="image/png" href="/favicon.png?v=nd-20261025" sizes="48x48">\n  <link rel="stylesheet" href="/branding.css">\n';

function shell(title, active, body) {
  const nav = policyDocuments.map(doc => `<a href="/${doc.file}"${active === doc.file ? ' aria-current="page"' : ''}>${escape(doc.title)}</a>`).join('');
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0b0b0e"><meta name="robots" content="noindex,nofollow">
  <meta name="nd-policy-revision" content="${POLICY_REVISION}"><meta name="nd-policy-status" content="draft">
  <meta name="description" content="Nightz AI Studio policy drafts for ai.nightz.dev only. Not final policies or active agreements.">
  <title>${escape(title)} | ND AI Studio</title>
${brandHead}  <link rel="stylesheet" href="/legal.css">
</head><body>
  <a class="legal-skip" href="#document">Skip to content</a>
  <header class="legal-header"><a class="legal-brand" href="/">${logo}<span>AI STUDIO<small>NIGHTZ DEVELOPMENT</small></span></a><a class="legal-back" href="/workspace.html#projects">Back to workspace</a></header>
  <main class="legal-layout" id="document"><aside class="legal-sidebar"><span class="legal-kicker">POLICY LIBRARY</span><nav aria-label="Policy documents"><a href="/policies.html"${!active ? ' aria-current="page"' : ''}>Overview</a>${nav}</nav><p>Scope: <strong>ai.nightz.dev</strong><br>Draft revision: 25 October 2026<br>No effective date assigned.</p></aside>
  <article class="legal-document"><div class="legal-status">DRAFT / NOT IN EFFECT</div><div class="legal-review"><strong>Review copy, not final policy.</strong><p>Business details and operating practices still need confirmation. This page does not create a new agreement, record consent or claim legal compliance.</p></div>${body}</article></main>
  <footer class="legal-footer"><span>Nightz Development / AI Studio</span>${policyLinks}</footer>
</body></html>\n`;
}
export function renderPolicyPages() {
  const entries = policyDocuments.map(doc => [doc.file, shell(doc.title, doc.file,
    `<p class="legal-kicker">${escape(doc.eyebrow)}</p><h1>${escape(doc.title)}</h1><p class="legal-lead">${escape(doc.summary)}</p>` +
    doc.sections.map(([heading, paragraphs], i) => `<section id="section-${i + 1}"><h2>${escape(heading)}</h2>${paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}</section>`).join('') +
    `<details class="legal-pending"><summary>What remains before final publication</summary><p>${escape(doc.pending)}</p><p>No business email or legal operator name is published here because those details have not been confirmed.</p></details>`)]);
  const cards = policyDocuments.map(doc => `<a class="legal-card" href="/${doc.file}"><span class="legal-kicker">${escape(doc.eyebrow)}</span><h2>${escape(doc.title)}</h2><p>${escape(doc.summary)}</p><span class="legal-read">Read draft &rarr;</span></a>`).join('');
  entries.unshift(['policies.html', shell('Policies', null,
    `<p class="legal-kicker">NIGHTZ DEVELOPMENT / AI STUDIO</p><h1>Clear information.<br>Simple policies.</h1><p class="legal-lead">Three short drafts for this workspace. No store-wide terms, invented payment rules or unverified privacy promises.</p><div class="legal-cards">${cards}</div><section><h2>Before these become active</h2><p>The operator must confirm the legal business identity, public contact, eligible ages and regions, pricing and output rights, service providers, retention and deletion practices.</p><p>There is no agreement checkbox or acceptance record for these drafts. Final terms and the accompanying privacy notice require review before an acceptance flow is enabled.</p></section>`)]);
  return Object.fromEntries(entries);
}
