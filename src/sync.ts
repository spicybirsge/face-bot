import { randomUUID } from 'node:crypto';
import type { Archive, BackfillProgress } from './archive.ts';
import type { NewsSource } from './config.ts';
import { isFollowedPost, normalizePost, type NewsMessage } from './news.ts';

export interface DiscordHistory {
  verifyChannel(): Promise<void>;
  fetchPage(limit: number, before: string | null): Promise<NewsMessage[]>;
}

const pageSize = 100;
const hour = 60 * 60_000;
const fullSyncInterval = 12 * hour;
const attachmentRefreshLead = hour;
const attachmentRetryInterval = 5 * 60_000;
const minAttachmentRetryInterval = 30_000;

function isNewer(id: string, checkpoint: string) {
  return BigInt(id) > BigInt(checkpoint);
}

export function createSync({ archive, discord, config }: { archive: Archive; discord: DiscordHistory; config: NewsSource }) {
  function nextFullSyncAt() {
    const lastFullSync = archive.getState('lastFullSyncAt');
    if (!lastFullSync) return 0;
    const lastFullSyncAt = Date.parse(lastFullSync);
    let earliestExpiry = Infinity;
    for (const value of archive.attachmentUrls()) {
      const url = URL.parse(value);
      if (!url || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
        || !url.pathname.startsWith('/attachments/')) continue;
      const expiry = url.searchParams.get('ex');
      if (expiry && /^[\da-f]{1,10}$/i.test(expiry)) {
        earliestExpiry = Math.min(earliestExpiry, Number.parseInt(expiry, 16) * 1000);
      }
    }
    // A fetched link can still be close to expiry. Shorten the retry delay to fit its remaining lifetime.
    const retryDelay = Math.max(minAttachmentRetryInterval,
      Math.min(attachmentRetryInterval, Math.floor((earliestExpiry - lastFullSyncAt) / 2)));
    const attachmentRefreshAt = Math.max(earliestExpiry - attachmentRefreshLead, lastFullSyncAt + retryDelay);
    return Math.min(lastFullSyncAt + fullSyncInterval, attachmentRefreshAt);
  }

  function writeMessages(messages: NewsMessage[], scanId?: string | null) {
    for (const message of messages) {
      if (isFollowedPost(message, config)) archive.writePost(message.id, normalizePost(message, config), scanId);
    }
  }

  async function fullScan(resync = false) {
    await discord.verifyChannel();
    const saved = archive.getState('backfill');
    if (!resync && saved?.complete) return { ...saved, ...archive.count() };

    // Only initial backfills resume. A resync starts at the top so a message
    // deleted while a previous run was interrupted cannot be marked as present.
    const progress: BackfillProgress = (!resync && saved) || { before: null, newest: '0', scanned: 0, complete: false };
    const scanId = resync ? randomUUID() : null;
    while (!progress.complete) {
      const page = await discord.fetchPage(pageSize, progress.before);
      if (!progress.before && page.length) progress.newest = page[0].id;
      if (page.length) progress.before = page[page.length - 1].id;
      progress.scanned += page.length;
      // The requested limit is a maximum. Confirm the end before pruning unseen posts.
      progress.complete = page.length === 0;

      if (progress.complete) await discord.verifyChannel();
      archive.transaction(() => {
        writeMessages(page, scanId);
        if (!resync || progress.complete) archive.setState('backfill', progress);
        if (progress.complete) {
          const completedAt = new Date().toISOString();
          archive.setState('checkpoint', progress.newest);
          archive.setState('lastSyncAt', completedAt);
          archive.setState('lastFullSyncAt', completedAt);
          if (scanId) archive.prune(scanId);
        }
      });
    }
    return { ...progress, ...archive.count() };
  }

  async function catchUp() {
    const backfill = !archive.getState('backfill')?.complete ? await fullScan() : null;
    await discord.verifyChannel();

    const checkpoint = archive.getState('checkpoint') ?? '0';
    let newest = checkpoint;
    let before: string | null = null;
    let scanned = backfill?.scanned ?? 0;
    while (true) {
      const page = await discord.fetchPage(pageSize, before);
      const newMessages = page.filter(message => isNewer(message.id, checkpoint));
      if (!before && newMessages.length) newest = newMessages[0].id;
      scanned += newMessages.length;
      const complete = page.length === 0 || newMessages.length < page.length;
      if (complete && !page.length) await discord.verifyChannel();
      archive.transaction(() => {
        writeMessages(newMessages);
        if (complete) {
          archive.setState('checkpoint', newest);
          archive.setState('lastSyncAt', new Date().toISOString());
        }
      });
      if (complete) return { scanned, complete, ...archive.count() };
      before = page[page.length - 1].id;
    }
  }

  function record(message: NewsMessage) {
    if (isFollowedPost(message, config)) archive.writePost(message.id, normalizePost(message, config));
  }

  function remove(ids: Iterable<string>) {
    archive.transaction(() => {
      for (const id of ids) archive.writePost(id, null);
    });
  }

  return { fullScan, catchUp, nextFullSyncAt, record, remove };
}
