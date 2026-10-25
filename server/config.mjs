export function readConfig(env = process.env) {
  const origin = new URL(env.APP_ORIGIN || 'https://ai.nightz.dev');
  const development = env.NODE_ENV === 'development';
  if (origin.origin !== (env.APP_ORIGIN || 'https://ai.nightz.dev') || origin.username || origin.password) {
    throw new Error('APP_ORIGIN must be an origin with no path or credentials.');
  }
  if (origin.protocol !== 'https:' && !(development && ['localhost', '127.0.0.1'].includes(origin.hostname))) {
    throw new Error('HTTPS is required except for explicit localhost development.');
  }
  const clientId = env.DISCORD_CLIENT_ID || '';
  const clientSecret = env.DISCORD_CLIENT_SECRET || '';
  if (Boolean(clientId) !== Boolean(clientSecret) || (clientId && !/^\d{17,20}$/.test(clientId))) {
    throw new Error('Configure both a valid DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.');
  }
  if (clientSecret && /[\r\n]/.test(clientSecret)) throw new Error('Invalid Discord secret.');
  const port = Number(env.PORT || 3081);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const ownerIds = (env.OWNER_DISCORD_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  if (ownerIds.length > 10 || ownerIds.some(id => !/^\d{17,20}$/.test(id))) throw new Error('Invalid owner Discord user IDs.');
  const botToken = env.DISCORD_BOT_TOKEN || '';
  const workerToken = env.STUDIO_WORKER_TOKEN || '';
  if (botToken && !/^[A-Za-z0-9_.-]{30,300}$/.test(botToken)) throw new Error('Invalid bot token format.');
  if (workerToken && !/^[a-f0-9]{64}$/.test(workerToken)) throw new Error('STUDIO_WORKER_TOKEN must be 32 random bytes encoded as 64 hexadecimal characters.');
  const secure = origin.protocol === 'https:';
  return {
    origin: origin.origin, clientId, clientSecret, port, secure, ownerIds, botToken, workerToken,
    redirectUri: `${origin.origin}/auth/discord/callback`,
    database: env.DATABASE_PATH || '/var/lib/nd-ai-studio/studio.sqlite',
    sessionCookie: secure ? '__Host-ndai-session' : 'ndai-session',
    flowCookie: secure ? '__Host-ndai-flow' : 'ndai-flow',
    sessionSeconds: 7 * 24 * 60 * 60,
  };
}
