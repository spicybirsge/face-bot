import {
  ChannelType, Client, Events, GatewayDispatchEvents, GatewayIntentBits,
  MessageFlags, PermissionFlagsBits, RESTJSONErrorCodes, Routes,
  type GatewayDispatchPayload, type RESTGetAPIChannelMessageResult, type RESTGetAPIChannelMessagesResult,
} from 'discord.js';
import type { RequestStats } from './api.ts';
import type { Archive } from './archive.ts';
import type { Config, NewsSource } from './config.ts';
import { isFollowedPost, isSourceDeleted, type NewsMessage } from './news.ts';
import { createSync, type DiscordHistory } from './sync.ts';

const retryDelay = 30_000;

interface DiscordConnection extends DiscordHistory {
  client: Client;
  fetchMessage(id: string): Promise<NewsMessage>;
}

export function createDiscord(config: NewsSource): DiscordConnection {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  client.on(Events.Error, error => reportDiscordError('Discord client', error));
  return {
    client,
    async verifyChannel() {
      const channel = await client.channels.fetch(config.channelId, { force: true });
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        throw new Error('DISCORD_NEWS_CHANNEL_ID must point to a server text or announcement channel the bot can access');
      }
      await channel.guild.roles.fetch();
      const me = await channel.guild.members.fetchMe({ force: true });
      if (!channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        throw new Error('The bot needs View Channel and Read Message History in the configured news channel');
      }
    },
    fetchPage(limit, before) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (before) query.set('before', before);
      return client.rest.get(Routes.channelMessages(config.channelId), { query }) as Promise<RESTGetAPIChannelMessagesResult>;
    },
    fetchMessage(id) {
      return client.rest.get(Routes.channelMessage(config.channelId, id)) as Promise<RESTGetAPIChannelMessageResult>;
    },
  };
}

export function reportDiscordError(context: string, error: unknown) {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  const detail = error instanceof Error && 'status' in error
    ? `HTTP ${error.status}, code ${code}`
    : (code ?? (error instanceof Error ? error.message : 'Unknown error'));
  console.error(`${context} failed (${detail})`);
}

function statsMessage(client: Client, archive: Archive, requestStats: RequestStats) {
  const http = requestStats.snapshot();
  const posts = archive.count();
  const uptimeSeconds = Math.floor((client.uptime ?? 0) / 1000);
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor(uptimeSeconds / 60) % 60;
  const latency = client.ws.ping >= 0 ? `${Math.round(client.ws.ping)} ms` : 'Unavailable';
  const lastSync = archive.getState('lastSyncAt');
  return [
    '**Bot**',
    `Uptime **${hours}h ${minutes}m ${uptimeSeconds % 60}s** · Gateway latency **${latency}** · Servers **${client.guilds.cache.size}**`,
    '**Archive**',
    `Stories **${posts.total}** · Uncategorized **${posts.uncategorized}**`,
    `Last history sync ${lastSync ? `<t:${Math.floor(Date.parse(lastSync) / 1000)}:R>` : '**Pending**'}`,
    '**HTTP since process start**',
    `Requests **${http.requests}** · Errors **${http.errors}** · Not modified **${http.notModified}** · Avg response **${http.averageMs.toFixed(1)} ms**`,
    `JSON **${http.routes['/v1/news']}** · RSS **${http.routes['/feed.xml']}** · Docs **${http.routes['/']}** · Other **${http.routes.other}**`,
  ].join('\n');
}

export function connectBot({ config, archive, discord, requestStats }: {
  config: NewsSource & Pick<Config, 'token'>;
  archive: Archive;
  discord: DiscordConnection;
  requestStats: RequestStats;
}) {
  const { client } = discord;
  const sync = createSync({ archive, discord, config });
  let queue: Promise<void> = Promise.resolve();
  let closing = false;
  let syncPending = false;
  let syncAgain = false;
  let syncRetry: NodeJS.Timeout | undefined;
  let loginRetry: NodeJS.Timeout | undefined;
  let loginAttempt: Promise<string | void> = Promise.resolve();
  let statsGuildId: string | undefined;
  let statsRegistered = false;
  let statsRegistration: Promise<void> | undefined;

  function enqueue(work: () => void | Promise<void>) {
    queue = queue.then(() => closing ? undefined : work()).catch(error => reportDiscordError('Discord archive update', error));
  }

  function scheduleCatchUp() {
    if (closing) return;
    if (syncPending) {
      syncAgain = true;
      return;
    }
    clearTimeout(syncRetry);
    syncPending = true;
    enqueue(async () => {
      try {
        const result = await sync.catchUp();
        console.log(`History sync scanned ${result.scanned} messages. ${result.total} stories archived, ${result.uncategorized} uncategorized.`);
        registerStats();
      } catch (error) {
        if (!closing) syncRetry = setTimeout(scheduleCatchUp, retryDelay);
        throw error;
      } finally {
        syncPending = false;
        if (syncAgain) {
          syncAgain = false;
          scheduleCatchUp();
        }
      }
    });
  }

  function registerStats() {
    if (closing || statsRegistered || statsRegistration) return;
    statsRegistration = client.channels.fetch(config.channelId).then(async channel => {
      if (!channel || !('guildId' in channel) || !channel.guildId) throw new Error('Could not find the news channel’s server');
      const application = client.application;
      if (!application) throw new Error('Discord application is unavailable');
      statsGuildId = channel.guildId;
      await application.commands.create({
        name: 'stats', description: 'Show bot, archive, and HTTP request statistics',
      }, statsGuildId);
      statsRegistered = true;
    }).catch(error => reportDiscordError('/stats registration', error)).finally(() => {
      statsRegistration = undefined;
    });
  }

  async function refreshMessage(id: string) {
    try {
      sync.record(await discord.fetchMessage(id));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === RESTJSONErrorCodes.UnknownMessage)) throw error;
      sync.remove([id]);
    }
  }

  client.on(Events.Raw, ({ t: event, d: data }: GatewayDispatchPayload) => {
    if (!data || !('channel_id' in data) || data.channel_id !== config.channelId) return;
    switch (event) {
      case GatewayDispatchEvents.MessageCreate:
        if (isFollowedPost(data, config)) {
          // A pending REST scan can already contain an edit to this message.
          if (syncPending) enqueue(() => refreshMessage(data.id));
          else enqueue(() => sync.record(data));
        }
        break;
      case GatewayDispatchEvents.MessageUpdate:
        if (isSourceDeleted(data)) enqueue(() => sync.remove([data.id]));
        else enqueue(() => refreshMessage(data.id));
        break;
      case GatewayDispatchEvents.MessageDelete:
        enqueue(() => sync.remove([data.id]));
        break;
      case GatewayDispatchEvents.MessageDeleteBulk:
        enqueue(() => sync.remove(data.ids));
        break;
    }
  });

  function onGatewayReady() {
    registerStats();
    scheduleCatchUp();
  }
  client.on(Events.ClientReady, onGatewayReady);
  client.on(Events.ShardResume, onGatewayReady);
  client.on(Events.ShardReady, () => {
    if (client.isReady()) onGatewayReady();
  });
  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'stats' || interaction.guildId !== statsGuildId) return;
    try {
      await interaction.reply({ content: statsMessage(client, archive, requestStats), flags: MessageFlags.Ephemeral });
    } catch (error) {
      reportDiscordError('/stats reply', error);
    }
  });

  function login() {
    loginAttempt = client.login(config.token).catch(error => {
      reportDiscordError('Discord login', error);
      if (!closing) loginRetry = setTimeout(login, retryDelay);
    });
  }
  login();

  return async () => {
    closing = true;
    clearTimeout(syncRetry);
    clearTimeout(loginRetry);
    await client.destroy();
    await Promise.all([queue, loginAttempt, statsRegistration]);
  };
}
