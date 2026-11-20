import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { Events, GatewayDispatchEvents as Dispatch, MessageFlags } from 'discord.js';
import { createApp, createRequestStats } from '../src/api.js';
import { acquireWriter, openArchive } from '../src/archive.js';
import { connectBot } from '../src/discord.js';
import { normalizePost } from '../src/news.js';
import { createSync } from '../src/sync.js';

const config = {
  channelId: '111111111111111111', sourceChannelId: '222222222222222222',
  followerWebhookId: '333333333333333333', nerdsRoleId: '444444444444444444',
};
const articleId = number => String(100000000000000000n + BigInt(number));
function message(number, fields = {}) {
  return {
    id: articleId(number), channel_id: config.channelId, flags: MessageFlags.IsCrosspost,
    message_reference: { channel_id: config.sourceChannelId },
    timestamp: new Date(Date.UTC(2026, 10, 7, 0, number)).toISOString(),
    content: `@Nerds AI 🔑 **[Story ${number}](https://example.com/feature_(technology))**\n\n> A useful update.\nSources: [Original](https://example.com/source?a=1&b=2)`,
    ...fields,
  };
}

function fixtures(t) {
  const archive = openArchive(':memory:', 'test');
  t.after(() => archive.close());
  const messages = new Map();
  const calls = [];
  const discord = {
    async verifyChannel() {},
    async fetchPage(limit, before) {
      calls.push(before);
      return [...messages.values()].filter(post => !before || BigInt(post.id) < BigInt(before))
        .sort((a, b) => b.id.localeCompare(a.id)).slice(0, limit);
    },
    async fetchMessage(id) { return messages.get(id); },
  };
  const sync = createSync({ archive, discord, config });
  return { archive, messages, calls, discord, sync };
}

test('normalizes followed posts, prefers source links, and leaves ambiguous labels unset', () => {
  const posted = normalizePost(message(1), config);
  assert.equal(posted.category, 'nerds-ai');
  assert.equal(posted.title, '🔑 Story 1');
  assert.equal(posted.summary, 'A useful update.');
  assert.deepEqual(posted.links, ['https://example.com/source?a=1&b=2', 'https://example.com/feature_(technology)']);
  assert.equal(normalizePost(message(2, { content: `<@&${config.nerdsRoleId}> Headline` }), config).category, 'nerds');
  assert.equal(normalizePost(message(3, { content: '@Nerds @Nerds AI News' }), config).category, null);
  assert.equal(normalizePost(message(4, { content: 'Headline about @Nerds' }), config).category, null);
  assert.equal(normalizePost(message(4, { content: '[title](javascript:alert(1))' }), config).links.length, 0);
  assert.equal(normalizePost(message(5, { message_reference: { channel_id: '9' }, webhook_id: config.followerWebhookId }), config), null);
  assert.equal(normalizePost(message(6, { flags: 0, message_reference: undefined, webhook_id: '9' }), config), null);
  assert.ok(normalizePost(message(7, { message_reference: undefined, webhook_id: config.followerWebhookId }), config));
  assert.equal(normalizePost(message(8, { flags: MessageFlags.IsCrosspost | MessageFlags.SourceMessageDeleted }), config), null);
});

test('resumes a backfill with unmatched pages and catches messages published during the gap', async t => {
  const { archive, messages, calls, discord, sync } = fixtures(t);
  for (let n = 1; n <= 210; n++) {
    messages.set(articleId(n), message(n, n > 110 ? { flags: 0, message_reference: undefined } : {}));
  }
  const fetchPage = discord.fetchPage;
  let fail = true;
  discord.fetchPage = async (limit, before) => {
    if (before && fail) throw new Error('Temporary network failure');
    return fetchPage(limit, before);
  };
  await assert.rejects(sync.fullScan(), /Temporary network failure/);
  assert.equal(archive.getState('backfill').before, articleId(111));
  assert.equal(archive.count().total, 0);

  fail = false;
  messages.set(articleId(211), message(211));
  const result = await sync.catchUp();
  assert.equal(calls[1], articleId(111));
  assert.equal(result.scanned, 211);
  assert.equal(result.total, 111);
  assert.equal(archive.getState('checkpoint'), articleId(211));
  assert.equal((await sync.catchUp()).scanned, 0);
  assert.equal(archive.count().total, 111);
});

test('catches a multi-page reconnect gap and only prunes after verified full resync', async t => {
  const { archive, messages, discord, sync } = fixtures(t);
  messages.set(articleId(1), message(1));
  await sync.catchUp();
  for (let n = 2; n <= 106; n++) messages.set(articleId(n), message(n));
  assert.equal((await sync.catchUp()).scanned, 105);
  assert.equal(archive.count().total, 106);

  messages.delete(articleId(1));
  messages.set(articleId(2), message(2, { content: 'Corrected title', edited_timestamp: '2026-11-09T00:00:00.000Z' }));
  let checks = 0;
  discord.verifyChannel = async () => {
    if (++checks === 2) throw new Error('Lost access');
  };
  await assert.rejects(sync.fullScan(true), /Lost access/);
  assert.equal(archive.count().total, 106);
  discord.verifyChannel = async () => {};
  assert.equal((await sync.fullScan(true)).total, 105);
  assert.equal(archive.list({ limit: 106 }).at(-1).title, 'Corrected title');
});

test('enforces a single archive writer and releases it at shutdown', () => {
  const folder = mkdtempSync(join(tmpdir(), 'face-bot-'));
  const path = join(folder, 'news.sqlite');
  try {
    const close = acquireWriter(path);
    try {
      assert.throws(() => acquireWriter(path), /already has a writer/);
    } finally {
      close();
    }
    acquireWriter(path)();
  } finally {
    rmSync(folder, { recursive: true });
  }
});

test('serves docs, paginated JSON and RSS with ETags and finished request counters', async t => {
  const { archive, sync } = fixtures(t);
  sync.record(message(1, { content: 'Story without label' }));
  sync.record(message(2, { content: '@Nerds Story & details\nA literal <b>tag</b>.\nhttps://example.com/?a=1&b=2' }));
  sync.record(message(3));
  const requestStats = createRequestStats();
  const app = createApp({ archive, publicBaseUrl: 'https://news.example.org', requestStats });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
  const conditional = etag => ({ headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } });

  const docs = await get('/');
  assert.match(docs.headers.get('content-type'), /text\/html/);
  assert.match(await docs.text(), /JSON archive/);

  const response = await get('/v1/news?limit=1');
  const etag = response.headers.get('etag');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const page = await response.json();
  assert.equal(page.items[0].title, '🔑 Story 3');
  const second = await (await get(`/v1/news?cursor=${page.nextCursor}`)).json();
  assert.deepEqual(second.items.map(post => post.title), ['Story & details', 'Story without label']);
  assert.equal(second.nextCursor, null);
  assert.equal((await (await get('/v1/news?category=nerds')).json()).items.length, 1);
  for (const query of ['?limit=101', '?limit=1&limit=2', '?cursor=x', '?category=other']) {
    assert.equal((await get(`/v1/news${query}`)).status, 400);
  }
  assert.equal((await get('/v1/news?limit=1', conditional(etag))).status, 304);

  for (const path of ['/v1/news', '/feed.xml']) {
    const preflight = await get(path, { method: 'OPTIONS', headers: {
      Origin: 'https://example.org', 'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'if-none-match',
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.match(preflight.headers.get('access-control-allow-headers'), /if-none-match/i);
  }

  const feed = await get('/feed.xml');
  assert.match(feed.headers.get('content-type'), /application\/rss\+xml/);
  const text = await feed.text();
  assert.match(text, /<title>Story &amp; details<\/title>/);
  assert.match(text, /<link>https:\/\/example.com\/\?a=1&amp;b=2<\/link>/);
  assert.match(text, /&amp;lt;b&amp;gt;tag&amp;lt;\/b&amp;gt;/);
  assert.ok(text.includes(`<guid isPermaLink="false">${page.items[0].id}</guid>`));
  assert.equal((await get('/feed.xml', conditional(feed.headers.get('etag')))).status, 304);
  sync.record(message(3, { content: 'Updated headline', edited_timestamp: '2026-11-09T00:00:00Z' }));
  const edited = await (await get('/v1/news?limit=1', conditional(etag))).json();
  assert.equal(edited.items[0].id, page.items[0].id);
  assert.equal(edited.items[0].title, 'Updated headline');
  sync.remove([articleId(3)]);
  assert.ok(!(await (await get('/feed.xml')).text()).includes(page.items[0].id));
  await tick();
  assert.deepEqual(requestStats.snapshot().routes, { '/': 1, '/v1/news': 9, '/feed.xml': 3, other: 2 });
  assert.equal(requestStats.snapshot().notModified, 2);
  assert.equal(requestStats.snapshot().errors, 4);
});

test('queues gateway events behind a catch-up and serves the stats command', async t => {
  const { archive, messages, discord } = fixtures(t);
  const client = Object.assign(new EventEmitter(), {
    login: async () => {}, destroy: async () => {}, uptime: 1000,
    ws: { ping: 8 }, guilds: { cache: new Map([['guild', {}]]) },
    channels: { fetch: async () => ({ guildId: 'guild' }) },
    application: { commands: { create: async command => assert.equal(command.name, 'stats') } },
  });
  discord.client = client;
  const stop = connectBot({ config, archive, discord, requestStats: createRequestStats() });
  t.after(stop);
  const raw = (event, data) => client.emit(Events.Raw, { t: event, d: { channel_id: config.channelId, ...data } });
  messages.set(articleId(1), message(1));
  messages.set(articleId(2), message(2, { content: 'Current title' }));

  client.emit(Events.ClientReady);
  raw(Dispatch.MessageCreate, message(2, { content: 'Stale title' }));
  raw(Dispatch.MessageDeleteBulk, { ids: [articleId(1)] });
  await tick();
  assert.deepEqual(archive.list({ limit: 5 }).map(post => post.title), ['Current title']);

  messages.set(articleId(2), message(2, { content: 'Edited live' }));
  raw(Dispatch.MessageUpdate, { id: articleId(2) });
  await tick();
  assert.equal(archive.list({ limit: 1 })[0].title, 'Edited live');
  raw(Dispatch.MessageUpdate, { id: articleId(2), flags: MessageFlags.SourceMessageDeleted });
  await tick();
  assert.equal(archive.count().total, 0);

  let reply;
  client.emit(Events.InteractionCreate, {
    isChatInputCommand: () => true, commandName: 'stats', guildId: 'guild', reply: async result => { reply = result; },
  });
  assert.match(reply.content, /Gateway latency \*\*8 ms\*\*/);
  assert.match(reply.content, /Requests \*\*0\*\*/);
  assert.equal(reply.flags, MessageFlags.Ephemeral);
});
