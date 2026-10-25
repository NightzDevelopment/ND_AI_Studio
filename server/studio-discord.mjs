import { StudioError, studioSettings, insist } from './studio-domain.mjs';

export async function discordRequest(config, path, fetcher = fetch) {
  insist(config.botToken, 503, 'Configure DISCORD_BOT_TOKEN privately on the server.');
  const response = await fetcher(`https://discord.com/api/v10${path}`, {
    headers: { authorization: `Bot ${config.botToken}` }, signal: AbortSignal.timeout(7000), redirect: 'error',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new StudioError(503, `Discord connection failed (${response.status}). Check the bot and guild configuration.`);
  const text = await response.text();
  insist(Buffer.byteLength(text) <= 262144, 503, 'Discord returned an oversized response.');
  return JSON.parse(text);
}
export async function memberRoles(store, config, user, { refresh = false, fetcher = fetch } = {}) {
  const { guildId } = studioSettings(store);
  if (!config.botToken || !guildId) return [];
  const cached = store.db.prepare('SELECT * FROM studio_roles WHERE user_id=?').get(user.id);
  if (!refresh && cached && cached.guild_id === guildId && cached.checked_at > Date.now() - 60000) return cached.ok ? JSON.parse(cached.roles) : [];
  let roles = [], ok = 0;
  try {
    const member = await discordRequest(config, `/guilds/${guildId}/members/${user.discord_id}`, fetcher);
    if (member && Array.isArray(member.roles) && member.roles.every(role => /^\d{17,20}$/.test(role))) { roles = member.roles; ok = 1; }
  } catch { /* Failed lookups remove elevated access. OAuth sign-in stays independent. */ }
  store.db.prepare('INSERT INTO studio_roles VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET guild_id=excluded.guild_id,roles=excluded.roles,checked_at=excluded.checked_at,ok=excluded.ok')
    .run(user.id, guildId, JSON.stringify(roles), Date.now(), ok);
  return roles;
}
