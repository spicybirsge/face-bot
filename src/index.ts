import { once } from 'node:events';
import type { Server } from 'node:http';
import { Events, type Client } from 'discord.js';
import { createApp, createRequestStats } from './api.ts';
import { acquireWriter, openArchive, type Archive } from './archive.ts';
import { readConfig } from './config.ts';
import { connectBot, createDiscord, reportDiscordError } from './discord.ts';
import { normalizePost } from './news.ts';
import { createSync } from './sync.ts';

async function run() {
  const command = process.argv[2] ?? 'serve';
  if (!['serve', 'backfill', 'resync', 'inspect'].includes(command) || process.argv.length > 3) {
    throw new Error('Use pnpm start, pnpm sync backfill, pnpm sync resync, or pnpm sync inspect');
  }

  const config = readConfig();
  const discord = createDiscord(config);
  if (command === 'inspect') {
    try {
      await waitForDiscord(discord.client, config.token);
      await discord.verifyChannel();
      const messages = await discord.fetchPage(30, null);
      const samples = messages.flatMap(message => {
        const post = normalizePost(message, config);
        return post ? [{ title: post.title, category: post.category, links: post.links.length }] : [];
      });
      console.log(JSON.stringify({ scanned: messages.length, samples }, null, 2));
    } finally {
      await discord.client.destroy();
    }
    return;
  }

  const scope = JSON.stringify([config.channelId, config.sourceChannelId ?? config.followerWebhookId]);
  const releaseWriter = acquireWriter(config.databasePath);
  let archive: Archive | undefined;
  let server: Server | undefined;
  let stopBot: ReturnType<typeof connectBot> | undefined;
  try {
    archive = openArchive(config.databasePath, scope);
    if (command !== 'serve') {
      await waitForDiscord(discord.client, config.token);
      const sync = createSync({ archive, discord, config });
      const result = command === 'resync' ? await sync.fullScan(true) : await sync.catchUp();
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const requestStats = createRequestStats();
    const app = createApp({ archive, requestStats, publicBaseUrl: config.publicBaseUrl });
    server = app.listen(config.port, config.host);
    await once(server, 'listening');
    console.log(`Tech News API listening on ${config.host}:${config.port}`);
    stopBot = connectBot({ config, archive, discord, requestStats });
    await new Promise<void>(resolve => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    try {
      await Promise.all([
        stopBot ? stopBot() : discord.client.destroy(),
        server?.listening ? new Promise<void>(resolve => server?.close(() => resolve())) : undefined,
      ]);
    } finally {
      archive?.close();
      releaseWriter();
    }
  }
}

function waitForDiscord(client: Client, token: string) {
  return Promise.all([once(client, Events.ClientReady, { signal: AbortSignal.timeout(60_000) }), client.login(token)]);
}

try {
  await run();
} catch (error) {
  reportDiscordError('Service', error);
  process.exitCode = 1;
}
