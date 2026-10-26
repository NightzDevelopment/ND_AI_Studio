import { brandHead, logo, policyLinks, policyNotice } from './policies.mjs';

// Apply shared presentation to the existing templates at build time. Exact markers
// make a future template mismatch fail the build instead of silently losing links.
function replaceOnce(source, marker, replacement, label) {
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`Expected one ${label} marker. Review the template before building.`);
  }
  return source.slice(0, first) + replacement + source.slice(first + marker.length);
}
export function renderSiteAsset(file, source) {
  if (file === 'index.html' || file === 'workspace.html') {
    source = replaceOnce(source, '</head>', brandHead + '</head>', `${file} head`);
    const mark = file === 'index.html' ? '<span class="brand-mark">N<span>D</span></span>' : '<b>N<span>D</span></b>';
    source = replaceOnce(source, mark, logo, `${file} logo`);
    source = replaceOnce(source, '</footer>', '<a href="/agent.html">Live agent / owner preview</a>' + policyLinks + '</footer>', `${file} footer`);
    if (file === 'workspace.html') {
      const login = '<a class="primary" href="/auth/discord">Continue with Discord</a>';
      source = replaceOnce(source, login, login + policyNotice, 'workspace login');
      const notice = '<p class="fine muted">This request and the current project\'s source are sent to the configured AI provider. Never include credentials.</p>';
      source = replaceOnce(source, notice, '<p class="fine muted">This request and the current project\'s source snapshot, not only the open file, are sent to the configured AI provider. Never include credentials. Review and test generated code. <a href="/privacy.html">Privacy draft</a> / <a href="/acceptable-use.html">AI &amp; use draft</a>.</p>', 'generation disclosure');
    }
  } else if (file === 'account.js') {
    source = replaceOnce(source, '<div class="identity-symbol" aria-hidden="true">ND</div>', '<div class="identity-symbol nd-brand-symbol">' + logo + '</div>', 'account logo');
    const login = '<a id="discord-login" class="primary discord-login" href="/auth/discord" hidden>Continue with Discord <span aria-hidden="true">↗</span></a>';
    source = replaceOnce(source, login, login + policyNotice, 'account login');
  }
  return source;
}
