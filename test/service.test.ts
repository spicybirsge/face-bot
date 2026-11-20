import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import {
  ApplicationCommandType, EmbedBuilder, Events, GatewayDispatchEvents as Dispatch, MessageFlags,
  type ApplicationCommandData, type Client, type InteractionReplyOptions,
} from 'discord.js';
import { createApp, createRequestStats } from '../src/api.ts';
import { acquireWriter, openArchive } from '../src/archive.ts';
import { connectBot } from '../src/discord.ts';
import { normalizePost, type NewsMessage, type NewsPost } from '../src/news.ts';
import { createSync, type DiscordHistory } from '../src/sync.ts';

const config = {
  channelId: '111111111111111111', sourceChannelId: '222222222222222222',
  followerWebhookId: '333333333333333333', nerdsRoleId: '444444444444444444',
  nerdsAiRoleId: null, token: 'test-token',
};
const articleId = (number: number) => String(100000000000000000n + BigInt(number));
function message(number: number, fields: Partial<NewsMessage> = {}): NewsMessage {
  return {
    id: articleId(number), channel_id: config.channelId, flags: MessageFlags.IsCrosspost,
    message_reference: { channel_id: config.sourceChannelId },
    timestamp: new Date(Date.UTC(2026, 10, 7, 0, number)).toISOString(),
    content: `@Nerds AI 🔑 **[Story ${number}](https://example.com/feature_(technology))**\n\n> A useful update.\nSources: [Original](https://example.com/source?a=1&b=2)`,
    ...fields,
  };
}

function fixtures(t: TestContext, path = ':memory:') {
  const archive = openArchive(path, 'test');
  t.after(() => archive.close());
  const messages = new Map<string, NewsMessage>();
  const calls: (string | null)[] = [];
  const discord: DiscordHistory & { fetchMessage(id: string): Promise<NewsMessage> } = {
    async verifyChannel() {},
    async fetchPage(limit, before) {
      calls.push(before);
      return [...messages.values()].filter(post => !before || BigInt(post.id) < BigInt(before))
        .sort((a, b) => b.id.localeCompare(a.id)).slice(0, limit);
    },
    async fetchMessage(id) {
      const post = messages.get(id);
      assert.ok(post, `Missing fixture message ${id}`);
      return post;
    },
  };
  const sync = createSync({ archive, discord, config });
  return { archive, messages, calls, discord, sync };
}

test('normalizes followed posts, prefers source links, and leaves ambiguous labels unset', () => {
  const posted = normalizePost(message(1), config);
  assert.ok(posted);
  assert.equal(posted.category, 'nerds-ai');
  assert.equal(posted.title, '🔑 Story 1');
  assert.equal(posted.summary, 'A useful update.');
  assert.equal(posted.raw_content, '🔑 **[Story 1](https://example.com/feature_(technology))**\n\n> A useful update.\nSources: [Original](https://example.com/source?a=1&b=2)');
  assert.deepEqual(posted.links, ['https://example.com/source?a=1&b=2', 'https://example.com/feature_(technology)']);
  assert.equal(normalizePost(message(2, { content: `<@&${config.nerdsRoleId}> Headline` }), config)?.category, 'nerds');
  assert.equal(normalizePost(message(2, { content: `<@&${config.nerdsRoleId}>\r\n    code  ` }), config)?.raw_content, '    code  ');
  const code = '\n    @Nerds AI is literal code\n    next line';
  const indented = normalizePost(message(2, { content: `@Nerds\n${code}` }), config);
  assert.equal(indented?.raw_content, code);
  assert.equal(indented?.category, 'nerds');
  const repeated = normalizePost(message(3, { content: '@Nerds @Nerds AI News' }), config);
  assert.equal(repeated?.category, null);
  assert.equal(repeated?.raw_content, 'News');
  const headline = normalizePost(message(3, { content: '@Nerds AI-powered tools' }), config);
  assert.equal(headline?.category, 'nerds');
  assert.equal(headline?.raw_content, 'AI-powered tools');
  assert.equal(normalizePost(message(4, { content: 'Headline about @Nerds' }), config)?.category, null);
  assert.equal(normalizePost(message(4, { content: '    Headline about @Nerds' }), config)?.raw_content, '    Headline about @Nerds');
  assert.equal(normalizePost(message(4, { content: '', embeds: [{ title: 'Embed headline' }] }), config)?.raw_content, '');
  assert.equal(normalizePost(message(4, { content: '[title](javascript:alert(1))' }), config)?.links.length, 0);
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
  assert.equal(archive.getState('backfill')?.before, articleId(111));
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
  assert.equal(archive.list({ limit: 106 }).at(-1)?.title, 'Corrected title');
});

test('continues past short history pages before advancing the checkpoint or pruning', async t => {
  const { archive, messages, discord, sync } = fixtures(t);
  const fetchPage = discord.fetchPage;
  discord.fetchPage = (limit, before) => fetchPage(Math.min(limit, 2), before);
  for (let n = 1; n <= 5; n++) messages.set(articleId(n), message(n));
  assert.equal((await sync.fullScan()).total, 5);

  messages.delete(articleId(2));
  const oldest = message(1, { content: 'Edited oldest story' });
  messages.set(oldest.id, oldest);
  assert.equal((await sync.fullScan(true)).total, 4);
  assert.equal(archive.list({ limit: 5 }).at(-1)?.title, 'Edited oldest story');

  for (let n = 6; n <= 8; n++) messages.set(articleId(n), message(n));
  assert.equal((await sync.catchUp()).scanned, 3);
  assert.equal(archive.count().total, 7);
  assert.equal(archive.getState('checkpoint'), articleId(8));
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

test('reads older archive rows and fills in Markdown on resync without changing article IDs', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'face-bot-'));
  const path = join(folder, 'news.sqlite');
  const { archive, messages, sync } = fixtures(t, path);
  t.after(() => rmSync(folder, { recursive: true }));

  const original = message(1, { content: '@Nerds **Original headline**' });
  messages.set(original.id, original);
  await sync.catchUp();
  const [post] = archive.list({ limit: 1 });

  const db = new DatabaseSync(path);
  try {
    db.exec("UPDATE posts SET article = json_remove(article, '$.raw_content')");
  } finally {
    db.close();
  }
  assert.deepEqual(archive.list({ limit: 1 }), [{ ...post, raw_content: null }]);

  await sync.fullScan(true);
  assert.deepEqual(archive.list({ limit: 1 }), [{ ...post, raw_content: '**Original headline**' }]);
});

test('serves docs, paginated JSON and RSS with ETags and finished request counters', async t => {
  const { archive, sync } = fixtures(t);
  sync.record(message(1, { content: 'Story without label' }));
  const markdown = 'Story & details\r\nA literal <b>tag</b>\f.\nhttps://example.com/?a=1&b=2';
  sync.record(message(2, { content: `@Nerds ${markdown}` }));
  sync.record(message(3));
  const requestStats = createRequestStats();
  const app = createApp({ archive, publicBaseUrl: 'https://news.example.org', requestStats });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const get = (path: string, options?: RequestInit) => fetch(`http://127.0.0.1:${address.port}${path}`, options);
  const conditional = (etag: string | null): RequestInit => {
    assert.ok(etag);
    return { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } };
  };
  const readPage = async (response: Response) => await response.json() as { items: NewsPost[]; nextCursor: string | null };

  const docs = await get('/');
  assert.match(docs.headers.get('content-type') ?? '', /text\/html/);
  const html = await docs.text();
  assert.match(html, /<title>Tech news from face attic's discord server<\/title>/);
  assert.match(html, /JSON archive/);

  const response = await get('/v1/news?limit=1');
  const etag = response.headers.get('etag');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const page = await readPage(response);
  assert.equal(page.items[0].title, '🔑 Story 3');
  const second = await readPage(await get(`/v1/news?cursor=${page.nextCursor}`));
  assert.deepEqual(second.items.map(post => post.title), ['Story & details', 'Story without label']);
  assert.equal(second.items[0].raw_content, markdown);
  assert.equal(second.nextCursor, null);
  assert.equal((await readPage(await get('/v1/news?category=nerds'))).items.length, 1);
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
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /if-none-match/i);
  }

  const feed = await get('/feed.xml');
  assert.match(feed.headers.get('content-type') ?? '', /application\/rss\+xml/);
  const text = await feed.text();
  assert.match(text, /<title>Story &amp; details<\/title>/);
  assert.match(text, /<link>https:\/\/example.com\/\?a=1&amp;b=2<\/link>/);
  assert.match(text, /&amp;lt;b&amp;gt;tag&amp;lt;\/b&amp;gt;/);
  assert.ok(text.includes('xmlns:face="https://github.com/spicybirsge/face-bot/ns/rss"'));
  assert.ok(text.includes('<face:raw_content>Story &amp; details&#13;\nA literal &lt;b&gt;tag&lt;/b&gt;.\nhttps://example.com/?a=1&amp;b=2</face:raw_content>'));
  assert.ok(text.includes(`<guid isPermaLink="false">${page.items[0].id}</guid>`));
  assert.equal((await get('/feed.xml', conditional(feed.headers.get('etag')))).status, 304);
  sync.record(message(3, { content: 'Updated headline', edited_timestamp: '2026-11-09T00:00:00Z' }));
  const edited = await readPage(await get('/v1/news?limit=1', conditional(etag)));
  assert.equal(edited.items[0].id, page.items[0].id);
  assert.equal(edited.items[0].title, 'Updated headline');
  assert.equal(edited.items[0].raw_content, 'Updated headline');
  sync.remove([articleId(3)]);
  assert.ok(!(await (await get('/feed.xml')).text()).includes(page.items[0].id));
  await tick();
  assert.deepEqual(requestStats.snapshot().routes, { '/': 1, '/v1/news': 9, '/feed.xml': 3, other: 2 });
  assert.equal(requestStats.snapshot().notModified, 2);
  assert.equal(requestStats.snapshot().errors, 4);
});

test('queues gateway events behind a catch-up and replaces stale slash commands on startup', async t => {
  const { archive, messages, discord } = fixtures(t);
  const deletedCommands: string[] = [];
  const registrations: string[] = [];
  const guildId = 'guild';
  const command = (name: string, scope: string | null, type = ApplicationCommandType.ChatInput) => ({
    name, guildId: scope, type,
    async delete() { deletedCommands.push(`${scope ?? 'global'}:${name}`); },
  });
  const globalCommands = [command('old-global', null), command('stats', null), command('Inspect', null, ApplicationCommandType.User)];
  const guildCommands = [command('old-local', guildId), command('stats', guildId), command('Quote', guildId, ApplicationCommandType.Message)];
  const client = Object.assign(new EventEmitter(), {
    login: async () => {}, destroy: async () => {}, uptime: 1000,
    ws: { ping: 8 }, guilds: { cache: new Map([[guildId, {}]]) },
    channels: { fetch: async () => ({ guildId }) },
    application: { commands: {
      async create(data: ApplicationCommandData, scope: string) {
        assert.equal(data.type, ApplicationCommandType.ChatInput);
        registrations.push(`${scope}:${data.name}`);
      },
      async fetch(options?: { guildId: string }) {
        if (!options) return globalCommands;
        assert.equal(options.guildId, guildId);
        return guildCommands;
      },
    } },
  });
  const connection = { ...discord, client: client as unknown as Client };
  const stop = connectBot({ config, archive, discord: connection, requestStats: createRequestStats() });
  t.after(stop);
  const raw = (event: Dispatch, data: object) => client.emit(Events.Raw, { t: event, d: { channel_id: config.channelId, ...data } });
  messages.set(articleId(1), message(1));
  messages.set(articleId(2), message(2, { content: 'Current title' }));

  client.emit(Events.ClientReady);
  raw(Dispatch.MessageCreate, message(2, { content: 'Stale title' }));
  raw(Dispatch.MessageDeleteBulk, { ids: [articleId(1)] });
  await tick();
  assert.deepEqual(archive.list({ limit: 5 }).map(post => post.title), ['Current title']);
  assert.deepEqual(deletedCommands, ['global:old-global', 'global:stats', 'guild:old-local']);
  client.emit(Events.ShardResume);
  await tick();
  assert.deepEqual(registrations, ['guild:stats']);

  messages.set(articleId(2), message(2, { content: 'Edited live' }));
  raw(Dispatch.MessageUpdate, { id: articleId(2) });
  await tick();
  assert.equal(archive.list({ limit: 1 })[0].title, 'Edited live');
  raw(Dispatch.MessageUpdate, { id: articleId(2), flags: MessageFlags.SourceMessageDeleted });
  await tick();
  assert.equal(archive.count().total, 0);

  const replies: InteractionReplyOptions[] = [];
  client.emit(Events.InteractionCreate, {
    isChatInputCommand: () => true, commandName: 'stats', guildId, reply: async (result: InteractionReplyOptions) => { replies.push(result); },
  });
  const reply = replies[0];
  const embed = reply?.embeds?.[0];
  assert.ok(embed instanceof EmbedBuilder);
  const { title, fields } = embed.toJSON();
  assert.equal(title, 'Bot and API stats');
  assert.match(fields?.find(field => field.name === 'Bot status')?.value ?? '', /Gateway latency \*\*8 ms\*\*/);
  assert.match(fields?.find(field => field.name === 'News archive')?.value ?? '', /Stories \*\*0\*\*/);
  assert.match(fields?.find(field => field.name === 'News archive')?.value ?? '', /Last full sync <t:\d+:R>/);
  assert.match(fields?.find(field => field.name === 'HTTP since startup')?.value ?? '', /Requests \*\*0\*\*/);
  assert.match(fields?.find(field => field.name === 'Requests by route')?.value ?? '', /RSS \*\*0\*\*/);
  assert.equal(reply.content, undefined);
  assert.equal(reply.flags, undefined);
});

test('refreshes attachment URLs on overdue startup, before expiry, and after twelve hours', async t => {
  const hour = 60 * 60_000;
  const initial = new Date('2026-11-21T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: initial });
  const { archive, messages, calls, discord, sync } = fixtures(t);
  function withAttachment(number: number, expiresIn: number) {
    const expiry = Math.floor((Date.now() + expiresIn) / 1000).toString(16);
    const url = `https://cdn.discordapp.com/attachments/${config.channelId}/${articleId(number)}/image.png?ex=${expiry}&hm=signature`;
    const post = message(number, {
      attachments: [{ id: articleId(number), filename: 'image.png', url, proxy_url: url, size: 1 }],
    });
    messages.set(post.id, post);
    return post;
  }
  const attachmentUrl = () => archive.list({ limit: 2 }).at(-1)?.attachments[0].url;

  withAttachment(1, 24 * hour);
  await sync.catchUp();
  const originalUrl = attachmentUrl();
  const originalId = archive.list({ limit: 1 })[0].id;
  t.mock.timers.setTime(initial.getTime() + 13 * hour);
  const refreshed = withAttachment(1, 4 * hour);

  const client = Object.assign(new EventEmitter(), {
    login: async () => {}, destroy: async () => {},
    channels: { fetch: async () => ({ guildId: 'guild' }) },
    application: { commands: { create: async () => {}, fetch: async () => [] } },
  });
  const fetchPage = discord.fetchPage;
  let fail = true;
  discord.fetchPage = async (limit, before) => {
    if (fail) {
      fail = false;
      throw new Error('Temporary network failure');
    }
    return fetchPage(limit, before);
  };
  const stop = connectBot({ config, archive, discord: { ...discord, client: client as unknown as Client }, requestStats: createRequestStats() });
  t.after(stop);

  client.emit(Events.ClientReady);
  await tick();
  assert.equal(archive.getState('lastFullSyncAt'), initial.toISOString());
  assert.equal(attachmentUrl(), originalUrl);
  t.mock.timers.tick(30_000);
  await tick();
  assert.equal(attachmentUrl(), refreshed.attachments?.[0].url);
  const firstResync = new Date().toISOString();
  assert.equal(archive.getState('lastFullSyncAt'), firstResync);

  t.mock.timers.tick(1_000);
  client.emit(Events.ShardResume);
  await tick();
  assert.equal(archive.getState('lastSyncAt'), new Date().toISOString());
  assert.equal(archive.getState('lastFullSyncAt'), firstResync);

  const shortLived = withAttachment(2, 2 * hour);
  client.emit(Events.Raw, { t: Dispatch.MessageCreate, d: shortLived });
  await tick();
  const latest = withAttachment(1, 24 * hour);
  withAttachment(2, 24 * hour);
  const before = calls.length;
  t.mock.timers.tick(hour - 1);
  await tick();
  assert.equal(calls.length, before);
  t.mock.timers.tick(1);
  await tick();
  assert.equal(calls.length, before + 2);
  assert.equal(attachmentUrl(), latest.attachments?.[0].url);
  assert.equal(archive.list({ limit: 2 }).at(-1)?.id, originalId);
  assert.equal(archive.getState('lastFullSyncAt'), new Date().toISOString());

  t.mock.timers.tick(12 * hour);
  await tick();
  assert.equal(calls.length, before + 4);
  assert.equal(archive.getState('lastFullSyncAt'), new Date().toISOString());

  const nearlyExpired = withAttachment(2, 2 * 60_000);
  client.emit(Events.Raw, { t: Dispatch.MessageUpdate, d: nearlyExpired });
  await tick();
  assert.equal(archive.list({ limit: 1 })[0].attachments[0].url, nearlyExpired.attachments?.[0].url);
  const renewed = withAttachment(2, 24 * hour);
  t.mock.timers.tick(60_000);
  await tick();
  assert.equal(calls.length, before + 6);
  assert.equal(archive.list({ limit: 1 })[0].attachments[0].url, renewed.attachments?.[0].url);
});
