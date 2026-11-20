# Discord news archive implementation plan

Build a discord.js bot that imports and follows published announcements copied into your server’s `#news` channel. Store the matching announcements in SQLite and serve them through a read-only Express JSON API and an RSS 2.0 feed. The full archive covers the available history in the destination channel. Unpublished messages and messages that were never copied there would require access to the upstream channel.

## 1. Confirm permissions and inspect sample posts

- Configure the destination channel ID and the followed announcement source. Give the bot `View Channel` and `Read Message History`, and enable the Message Content intent so it can read text, embeds, and attachments.
- Inspect a small sample of real Discord payloads for both `@Nerds` and `@Nerds AI`. Use the crosspost reference to identify the source channel, with a verified follower webhook ID as a fallback where needed. Filter out local messages and crossposts from other sources.
- Check which category signals survive Channel Following. Use a verified role ID or an exact leading label when available. If labels are separate messages, verify a reliable way to associate them with articles before using them. Store ambiguous or missing labels as `null` so those stories still appear in the combined archive.

## 2. Set up configuration and SQLite storage

- Initialize the Node.js project with discord.js and Express. Document the bot token, channel and source settings, listening port, public base URL, and SQLite file path in a sample configuration. Keep real credentials and local database files out of Git.
- Store a stable article ID, title, publication and edit timestamps, category, and article links. Keep Discord identifiers and sync checkpoints internal. Use message IDs as strings and a uniqueness constraint to make retries safe.
- Use the same parser for history imports and live messages. Validate article URLs and handle posts whose links, formatting, or category differ from the sample.

## 3. Import the available channel history

- Provide an operator command for the initial backfill and manual resync. Fetch up to 100 messages per Discord request and page backward using the oldest fetched message ID until an empty page confirms the end. The final count of archived stories depends on which messages match the followed source.
- Fetch pages sequentially and let discord.js queue requests around rate limits. Write each page and its progress cursor in one SQLite transaction so the importer can resume after a failure. Record progress across fetched messages even if a page has zero matching stories.
- Report the number scanned, archived, and left uncategorized, plus whether the backfill completed. Re-running the import should keep article IDs stable and avoid duplicate stories.

## 4. Sync new posts, edits, and deletions

- Subscribe to message create, update, and delete events, including bulk deletes. Apply updates to the existing record and remove a story from both outputs when the copy is deleted or Discord marks its upstream post as deleted.
- On startup or after a connection gap, page from the newest messages back to the last successful sync checkpoint. Advance the checkpoint only after the gap is covered. Coordinate events and fetches so a page cannot overwrite a newer edit or restore a deleted story.
- Run a full resync periodically to refresh signed attachment URLs and reconcile older edits or deletions missed while offline. Keep the operator command available. Only remove missing rows after a complete scan with verified channel access. Keep serving the saved archive during a Discord outage.

## 5. Serve the JSON archive and RSS feed

- `GET /v1/news` returns newest-first JSON with a default page size of 50, a maximum of 100, and an opaque `nextCursor` for older results. Support `category=nerds` and `category=nerds-ai`. Requests without a category include uncategorized posts. Return a clear `400` response for invalid parameters.
- `GET /feed.xml` returns the latest 50 stories as RSS 2.0. Use stable item GUIDs, original article URLs when available, and XML escaping for titles and any descriptions. Use the same publication ordering and records as the JSON API.
- Read both endpoints from SQLite. Support `ETag` and `If-None-Match` so unchanged responses can return `304`. New posts, edits, and deletions that change an endpoint’s response also change its ETag. Public requests never initiate a Discord sync.

## 6. Verify the complete flow and document operation

- Verify that the importer traverses all available pages, resumes from a saved cursor, and produces no duplicates on retry. Check that unrelated Discord messages stay out and verify category handling against the sample payloads.
- Verify that a new post, an edit, and a deletion appear correctly in JSON and RSS. Test recovery from a missed connection and confirm that the saved archive stays available during the outage.
- Verify JSON cursor boundaries and filters, valid RSS XML, stable GUIDs, and conditional `304` responses. Document bot setup, the initial import, configuration, service startup, and manual resync.
