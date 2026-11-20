import { randomUUID } from 'node:crypto';
import { isFollowedPost, normalizePost } from './news.js';

const pageSize = 100;

function isNewer(id, checkpoint) {
  return BigInt(id) > BigInt(checkpoint);
}

export function createSync({ archive, discord, config }) {
  function writeMessages(messages, scanId) {
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
    const progress = (!resync && saved) || { before: null, newest: '0', scanned: 0, complete: false };
    const scanId = resync ? randomUUID() : null;
    while (!progress.complete) {
      const page = await discord.fetchPage(pageSize, progress.before);
      if (!progress.before && page.length) progress.newest = page[0].id;
      if (page.length) progress.before = page.at(-1).id;
      progress.scanned += page.length;
      progress.complete = page.length < pageSize;

      if (progress.complete) await discord.verifyChannel();
      archive.transaction(() => {
        writeMessages(page, scanId);
        if (!resync || progress.complete) archive.setState('backfill', progress);
        if (progress.complete) {
          archive.setState('checkpoint', progress.newest);
          archive.setState('lastSyncAt', new Date().toISOString());
          if (resync) archive.prune(scanId);
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
    let before = null;
    let scanned = backfill?.scanned ?? 0;
    while (true) {
      const page = await discord.fetchPage(pageSize, before);
      const newMessages = page.filter(message => isNewer(message.id, checkpoint));
      if (!before && newMessages.length) newest = newMessages[0].id;
      scanned += newMessages.length;
      const complete = newMessages.length < pageSize;
      if (complete && !page.length) await discord.verifyChannel();
      archive.transaction(() => {
        writeMessages(newMessages);
        if (complete) {
          archive.setState('checkpoint', newest);
          archive.setState('lastSyncAt', new Date().toISOString());
        }
      });
      if (complete) return { scanned, complete, ...archive.count() };
      before = page.at(-1).id;
    }
  }

  function record(message) {
    if (isFollowedPost(message, config)) archive.writePost(message.id, normalizePost(message, config));
  }

  function remove(ids) {
    archive.transaction(() => {
      for (const id of ids) archive.writePost(id, null);
    });
  }

  return { fullScan, catchUp, record, remove };
}
