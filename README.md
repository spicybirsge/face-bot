# Tech News API Powered by [Face's attic discord server](https://discord.gg/EDvZwmcJX5)

This is a simple discord bot that exposes tech news posted in Face's attic discord server nerd stuff channel to a public api and also an rss feed.

## Set up

1. Install Node.js 24 or later and pnpm, then run `pnpm install --frozen-lockfile`.
2. Create a Discord bot in the Developer Portal and turn on **Message Content Intent**. Install it to the server with the `bot` and `applications.commands` scopes. Give it **View Channel** and **Read Message History** in the channel that receives the followed posts.
3. Copy [.env.example](.env.example) to `.env`. Set `DISCORD_BOT_TOKEN` and `DISCORD_NEWS_CHANNEL_ID` to the bot token and the destination channel in your server. Set `DISCORD_SOURCE_CHANNEL_ID` to the upstream announcement channel ID. You can use `DISCORD_FOLLOWER_WEBHOOK_ID` for a known Channel Following webhook when a crosspost lacks its source reference.
4. For a hosted service, set `PUBLIC_BASE_URL` to the public HTTPS origin clients use, such as `https://news.example.org`. Use the scheme and host with no path. The RSS feed uses this origin for its site and self links. For local development, leave it unset to use `http://localhost:<PORT>`. Set `PORT`, `HOST`, and `DATABASE_PATH` as needed, and put the SQLite file on persistent storage when hosting the service.
5. Run `pnpm sync inspect` to check the title and category detected on recent posts, then run `pnpm start`. Browse the docs at `http://localhost:3000/` with the default settings. On startup, the bot registers `/stats` in the destination server and removes its application's global slash commands and any other slash commands registered in that server. This also clears stale commands when you reuse a bot application. Discord clients may take time to reflect global command removals.

For local development, run `pnpm dev` with the same `.env` setup. The bot and API restart automatically when you edit the TypeScript source.

Discord can strip role mentions when following a channel. The parser recognizes a leading `@Nerds` or `@Nerds AI` label that survives in the same message. If role mention tokens survive, `DISCORD_NERDS_ROLE_ID` and `DISCORD_NERDS_AI_ROLE_ID` let you map those IDs. Unlabeled or ambiguous posts show a `null` category. Attachment links are Discord URLs and can expire.

## History and recovery

The service imports the available destination history when first started, resumes interrupted imports from a saved cursor, and catches up after a restart or gateway reconnect. Live edits and deletions update both outputs. The service keeps serving saved news while Discord is unavailable.

- Run `pnpm sync backfill` to import or resume the history before starting the service. The command prints counts for messages scanned and stories archived.
- Run `pnpm sync resync` to compare the archive with the full current destination history and remove archived posts that were deleted while the bot was offline. A failed scan can be rerun from the top. Only a completed resync can remove posts based on absence.
- Stop the service before running either write command. The archive allows one writer process at a time. `pnpm sync inspect` can run alongside the service. Use a new `DATABASE_PATH` when changing to a different source or destination.

## API

| Route | Response |
| --- | --- |
| `GET /` | HTML documentation and links |
| `GET /v1/news` | JSON with `items` and `nextCursor` |
| `GET /feed.xml` | RSS 2.0 with up to 50 items |

Use `limit` from 1 to 100 (default 50) and optional `category=nerds` or `category=nerds-ai`. Pass `nextCursor` back as `cursor` with the same category to get the next page. Each item includes `id`, `title`, `summary`, `category`, `publishedAt`, `updatedAt`, `links`, and `attachments`. Both data routes support `ETag` and `If-None-Match`.

The service runs directly from TypeScript on Node.js 24. Run `pnpm typecheck` for strict type checking and `pnpm test` for the offline sync, parsing, and API checks.
