import { readFileSync } from 'node:fs';
import express, { type ErrorRequestHandler } from 'express';
import type { Archive, PostCursor } from './archive.ts';
import { categories, type Category, type NewsPost } from './news.ts';

const docs = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const pageSize = 50;
const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const escapeXml = (text: string) => text
  .replace(/[^\u0009\u000a\u000d\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/[&<>"']/g, character => entities[character]);

function encodeCursor({ publishedAt, id }: PostCursor) {
  return Buffer.from(JSON.stringify([publishedAt, id])).toString('base64url');
}

function decodeCursor(encoded: unknown): PostCursor | null {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(encoded)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Array.isArray(decoded)) return null;
    const [publishedAt, id] = decoded;
    if (typeof publishedAt !== 'string' || new Date(publishedAt).toISOString() !== publishedAt) return null;
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return null;
    if (encodeCursor({ publishedAt, id }) === encoded) return { publishedAt, id };
  } catch {
    // Malformed cursors are handled as bad requests.
  }
  return null;
}

function rss(posts: NewsPost[], baseUrl: string) {
  const root = escapeXml(baseUrl);
  const lastChanged = posts.map(post => post.updatedAt ?? post.publishedAt).sort().at(-1);
  const items = posts.map(post => `    <item>
      <title>${escapeXml(post.title)}</title>
      <guid isPermaLink="false">${post.id}</guid>
      <pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>
${post.links.length ? `      <link>${escapeXml(post.links[0])}</link>\n` : ''}${post.category ? `      <category>${post.category}</category>\n` : ''}${post.summary ? `      <description>${escapeXml(escapeXml(post.summary))}</description>\n` : ''}    </item>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Tech News</title>
    <link>${root}/</link>
    <description>Recent stories from the tech news archive.</description>
    <atom:link href="${root}/feed.xml" rel="self" type="application/rss+xml"/>
${lastChanged ? `    <lastBuildDate>${new Date(lastChanged).toUTCString()}</lastBuildDate>\n` : ''}${items.join('\n')}
  </channel>
</rss>`;
}

export function createRequestStats() {
  const routes = { '/': 0, '/v1/news': 0, '/feed.xml': 0, other: 0 };
  let requests = 0;
  let errors = 0;
  let notModified = 0;
  let totalMs = 0;
  return {
    record(route: unknown, statusCode: number, elapsedMs: number) {
      requests += 1;
      const key = typeof route === 'string' && Object.hasOwn(routes, route) ? route as keyof typeof routes : 'other';
      routes[key] += 1;
      if (statusCode >= 400) errors += 1;
      if (statusCode === 304) notModified += 1;
      totalMs += elapsedMs;
    },
    snapshot: () => ({ requests, errors, notModified, averageMs: requests ? totalMs / requests : 0, routes: { ...routes } }),
  };
}

export type RequestStats = ReturnType<typeof createRequestStats>;

function isCategory(value: unknown): value is Category {
  return categories.some(category => category === value);
}

export function createApp({ archive, publicBaseUrl, requestStats }: {
  archive: Pick<Archive, 'list'>;
  publicBaseUrl: string;
  requestStats: RequestStats;
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', 'strong');
  app.use((req, res, next) => {
    const start = performance.now();
    res.once('finish', () => requestStats.record(req.route?.path, res.statusCode, performance.now() - start));
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/', (_req, res) => res.type('html').send(docs));

  const publicRead: express.RequestHandler = (_req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag' });
    next();
  };
  app.options(['/v1/news', '/feed.xml'], publicRead, (_req, res) => {
    res.set({
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'If-None-Match',
    }).status(204).end();
  });
  app.get('/v1/news', publicRead, (req, res) => {
    const { limit = String(pageSize), category, cursor } = req.query;
    if (typeof limit !== 'string' || !/^(?:[1-9]\d?|100)$/.test(limit)) {
      return res.status(400).json({ error: 'limit must be an integer from 1 to 100' });
    }
    if (category !== undefined && !isCategory(category)) {
      return res.status(400).json({ error: 'category must be nerds or nerds-ai' });
    }
    const decoded = cursor === undefined ? null : decodeCursor(cursor);
    if (cursor !== undefined && !decoded) return res.status(400).json({ error: 'cursor must be a nextCursor from the API' });

    const size = Number(limit);
    const items = archive.list({ limit: size + 1, category, cursor: decoded });
    const more = items.length > size;
    if (more) items.pop();
    res.set('Cache-Control', 'public, no-cache').json({ items, nextCursor: more ? encodeCursor(items[size - 1]) : null });
  });

  app.get('/feed.xml', publicRead, (_req, res) => {
    res.set('Cache-Control', 'public, no-cache').type('application/rss+xml')
      .send(rss(archive.list({ limit: pageSize }), publicBaseUrl));
  });

  app.use((_req, res) => res.status(404).json({ error: 'Resource not found' }));
  const handleError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) return next(error);
    console.error('HTTP request failed:', error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(handleError);
  return app;
}
