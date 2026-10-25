import { createHash } from 'node:crypto';

export function authorizeUrl(config, state, verifier) {
  const params = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: 'identify', state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

export async function discordIdentity(config, code, verifier, fetcher = fetch) {
  const token = await fetcher('https://discord.com/api/oauth2/token', {
    method: 'POST', signal: AbortSignal.timeout(10000), redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
      grant_type: 'authorization_code', redirect_uri: config.redirectUri, code, code_verifier: verifier }),
  });
  if (!token.ok) throw new Error('Discord token exchange failed.');
  const bundle = await token.json();
  if (typeof bundle.access_token !== 'string' || bundle.token_type?.toLowerCase() !== 'bearer') {
    throw new Error('Discord returned an invalid token.');
  }
  const response = await fetcher('https://discord.com/api/v10/users/@me', {
    signal: AbortSignal.timeout(10000), redirect: 'error', headers: { authorization: `Bearer ${bundle.access_token}` },
  });
  if (!response.ok) throw new Error('Discord profile request failed.');
  const user = await response.json();
  if (!/^\d{17,20}$/.test(user.id) || typeof user.username !== 'string' || !user.username || user.bot) {
    throw new Error('Discord returned an invalid user.');
  }
  return {
    id: user.id, username: user.username.slice(0, 80),
    displayName: (user.global_name || user.username).slice(0, 80),
    avatar: typeof user.avatar === 'string' && /^(a_)?[a-f0-9]{32}$/.test(user.avatar) ? user.avatar : null,
  };
}
