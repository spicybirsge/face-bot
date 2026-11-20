import { resolve } from 'node:path';

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  function discordId(name: string, required: true): string;
  function discordId(name: string, required?: false): string | null;
  function discordId(name: string, required = false): string | null {
    const value = env[name]?.trim();
    if ((!value && required) || (value && !/^\d{17,20}$/.test(value))) {
      throw new Error(`${name} must be a Discord ID`);
    }
    return value || null;
  }

  const token = env.DISCORD_BOT_TOKEN?.trim();
  if (!token) throw new Error('Set DISCORD_BOT_TOKEN');
  const channelId = discordId('DISCORD_NEWS_CHANNEL_ID', true);
  const sourceChannelId = discordId('DISCORD_SOURCE_CHANNEL_ID');
  const followerWebhookId = discordId('DISCORD_FOLLOWER_WEBHOOK_ID');
  if (!sourceChannelId && !followerWebhookId) {
    throw new Error('Set DISCORD_SOURCE_CHANNEL_ID or DISCORD_FOLLOWER_WEBHOOK_ID');
  }
  if (channelId === sourceChannelId) throw new Error('Use separate destination and source channel IDs');

  const nerdsRoleId = discordId('DISCORD_NERDS_ROLE_ID');
  const nerdsAiRoleId = discordId('DISCORD_NERDS_AI_ROLE_ID');
  if (nerdsRoleId && nerdsRoleId === nerdsAiRoleId) throw new Error('Use distinct category role IDs');

  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be from 1 to 65535');
  const publicUrl = new URL(env.PUBLIC_BASE_URL || `http://localhost:${port}`);
  if (!['https:', 'http:'].includes(publicUrl.protocol) || publicUrl.href !== `${publicUrl.origin}/`) {
    throw new Error('PUBLIC_BASE_URL must be an HTTP or HTTPS origin');
  }
  return {
    token, channelId, sourceChannelId, followerWebhookId, nerdsRoleId, nerdsAiRoleId, port,
    host: env.HOST?.trim() || '0.0.0.0',
    databasePath: resolve(env.DATABASE_PATH || './data/news.sqlite'),
    publicBaseUrl: publicUrl.origin,
  };
}

export type Config = ReturnType<typeof readConfig>;
export type NewsSource = Pick<Config, 'channelId' | 'sourceChannelId' | 'followerWebhookId' | 'nerdsRoleId' | 'nerdsAiRoleId'>;
