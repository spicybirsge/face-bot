import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// A separate SQLite lock lets the service or an operator sync own the archive
// across page commits. The OS releases it if the process exits unexpectedly.
export function acquireWriter(path) {
  mkdirSync(dirname(path), { recursive: true });
  const lock = new DatabaseSync(`${path}.writer.sqlite`);
  try {
    lock.exec('BEGIN IMMEDIATE');
  } catch (error) {
    lock.close();
    if (error.errcode === 5) throw new Error('The archive already has a writer. Stop the service or sync process first.');
    throw error;
  }
  return () => lock.close();
}

export function openArchive(path, scope) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS posts (
      message_id TEXT PRIMARY KEY,
      id TEXT UNIQUE NOT NULL,
      published_at TEXT NOT NULL,
      category TEXT,
      article TEXT NOT NULL,
      scan_id TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS posts_order ON posts (published_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS posts_category_order ON posts (category, published_at DESC, id DESC);
  `);

  const readState = db.prepare('SELECT value FROM sync_state WHERE key = ?');
  const writeState = db.prepare(`
    INSERT INTO sync_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const getState = key => JSON.parse(readState.get(key)?.value ?? 'null');
  const setState = (key, value) => writeState.run(key, JSON.stringify(value));
  const storedScope = getState('scope');
  if (storedScope !== null && storedScope !== scope) {
    db.close();
    throw new Error('This database belongs to another news source. Set DATABASE_PATH to a separate file.');
  }
  if (storedScope === null) setState('scope', scope);

  const upsert = db.prepare(`
    INSERT INTO posts (message_id, id, published_at, category, article, scan_id) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      published_at = excluded.published_at,
      category = excluded.category,
      article = excluded.article,
      scan_id = excluded.scan_id
  `);
  const deletePost = db.prepare('DELETE FROM posts WHERE message_id = ?');
  const prune = db.prepare('DELETE FROM posts WHERE scan_id IS NOT ?');
  const count = db.prepare('SELECT count(*) AS total, count(*) - count(category) AS uncategorized FROM posts');

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function writePost(messageId, post, scanId = null) {
    if (!post) return deletePost.run(messageId);
    return upsert.run(messageId, post.id, post.publishedAt, post.category, JSON.stringify(post), scanId);
  }

  function list({ limit, category, cursor }) {
    const conditions = [];
    const parameters = [];
    if (category) {
      conditions.push('category = ?');
      parameters.push(category);
    }
    if (cursor) {
      conditions.push('(published_at, id) < (?, ?)');
      parameters.push(cursor.publishedAt, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return db.prepare(`SELECT article FROM posts ${where} ORDER BY published_at DESC, id DESC LIMIT ?`)
      .all(...parameters, limit).map(row => JSON.parse(row.article));
  }

  return {
    getState, setState, transaction, writePost, list,
    count: () => ({ ...count.get() }),
    prune: scanId => prune.run(scanId).changes,
    close: () => db.close(),
  };
}
