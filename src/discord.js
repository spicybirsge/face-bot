import {
  ChannelType, Client, Events, GatewayDispatchEvents, GatewayIntentBits,
  MessageFlags, PermissionFlagsBits, RESTJSONErrorCodes, Routes,
} from 'discord.js';
import { isFollowedPost, isSourceDeleted } from './news.js';
import { createSync } from './sync.js';

const retryDelay = 30_000;

export function createDiscord(config) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  client.on(Events.Error, error => reportDiscordError('Discord client', error));
  return {
    client,
    async verifyChannel() {
      const channel = await client.channels.fetch(config.channelId, { force: true });
      if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
        throw new Error('DISCORD_NEWS_CHANNEL_ID must point to a server text or announcement channel the bot can access');
      }
      await channel.guild.roles.fetch();
      const me = await channel.guild.members.fetchMe({ force: true });
      if (!channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        throw new Error('The bot needs View Channel and Read Message History in the configured news channel');
      }
      return channel;
    },
    fetchPage(limit, before) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (before) query.set('before', before);
      return client.rest.get(Routes.channelMessages(config.channelId), { query });
    },
    fetchMessage(id) {
      return client.rest.get(Routes.channelMessage(config.channelId, id));
    },
  };
}

export function reportDiscordError(context, error) {
  const detail = error.status ? `HTTP ${error.status}, code ${error.code}` : (error.code ?? error.message);
  console.error(`${context} failed (${detail})`);
}

function statsMessage(client, archive, requestStats) {
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

export function connectBot({ config, archive, discord, requestStats }) {
  const { client } = discord;
  const sync = createSync({ archive, discord, config });
  let queue = Promise.resolve();
  let closing = false;
  let syncPending = false;
  let syncAgain = false;
  let syncRetry;
  let loginRetry;
  let loginAttempt = Promise.resolve();
  let statsGuildId;
  let statsRegistered = false;
  let statsRegistration;

  function enqueue(work) {
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
      if (!channel?.guildId) throw new Error('Could not find the news channel’s server');
      statsGuildId = channel.guildId;
      await client.application.commands.create({
        name: 'stats', description: 'Show bot, archive, and HTTP request statistics',
      }, statsGuildId);
      statsRegistered = true;
    }).catch(error => reportDiscordError('/stats registration', error)).finally(() => {
      statsRegistration = undefined;
    });
  }

  async function refreshMessage(id) {
    try {
      sync.record(await discord.fetchMessage(id));
    } catch (error) {
      if (error.code !== RESTJSONErrorCodes.UnknownMessage) throw error;
      sync.remove([id]);
    }
  }

  client.on(Events.Raw, ({ t: event, d: data }) => {
    if (data?.channel_id !== config.channelId) return;
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
