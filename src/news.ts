import { createHash } from 'node:crypto';
import { MessageFlags, type APIMessage } from 'discord.js';
import { Lexer, marked, Parser } from 'marked';
import type { NewsSource } from './config.ts';

export const categories = ['nerds', 'nerds-ai'] as const;
export type Category = (typeof categories)[number];
type MessageSource = Pick<APIMessage, 'channel_id'> & Partial<Pick<APIMessage, 'message_reference' | 'webhook_id'>> & { flags?: number };
export type NewsMessage = MessageSource & Pick<APIMessage, 'id' | 'timestamp'> &
  Partial<Pick<APIMessage, 'content' | 'edited_timestamp' | 'embeds' | 'attachments'>>;
export interface NewsPost {
  id: string;
  title: string;
  summary: string | null;
  raw_content: string | null;
  category: Category | null;
  publishedAt: string;
  updatedAt: string | null;
  links: string[];
  attachments: { url: string; name: string; contentType: string | null }[];
}

export function isFollowedPost(message: MessageSource, config: NewsSource) {
  if (message.channel_id !== config.channelId) return false;
  const source = message.message_reference?.channel_id;
  const isCrosspost = Boolean((message.flags ?? 0) & MessageFlags.IsCrosspost);
  if (isCrosspost && source && config.sourceChannelId) return source === config.sourceChannelId;
  return Boolean(config.followerWebhookId && message.webhook_id === config.followerWebhookId);
}

export function isSourceDeleted(message: Pick<MessageSource, 'flags'>) {
  return Boolean((message.flags ?? 0) & MessageFlags.SourceMessageDeleted);
}

function readLabels(content: string, config: NewsSource) {
  const labels = new Set<Category | null>();
  let rest = content;
  const prefix = /^\s*(?:<@&(\d+)>|@(Nerds(?:[ \t]+AI)?)(?![\p{L}\p{N}_]))[^\S\r\n]*(?:\r\n?|\n)?/iu;
  for (let match; (match = prefix.exec(rest)); rest = rest.slice(match[0].length)) {
    const [, roleId, text] = match;
    if (text) labels.add(/ai$/i.test(text) ? 'nerds-ai' : 'nerds');
    else if (roleId === config.nerdsRoleId) labels.add('nerds');
    else if (roleId === config.nerdsAiRoleId) labels.add('nerds-ai');
    else labels.add(null);
  }
  return { rest, category: labels.size === 1 ? labels.values().next().value ?? null : null };
}

function plainText(text: string) {
  const discordText = text.replace(/<a?:([\w]+):\d+>/g, ':$1:').replace(/<[@#][!&]?\d+>/g, '');
  const parser = new Parser();
  return parser.parseInline(Lexer.lexInline(discordText), parser.textRenderer).replace(/\s+/g, ' ').trim();
}

function articleUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {
    // Ignore malformed links.
  }
  return null;
}

export function normalizePost(message: NewsMessage, config: NewsSource): NewsPost | null {
  if (!isFollowedPost(message, config) || isSourceDeleted(message)) return null;

  const { rest, category } = readLabels(message.content ?? '', config);
  const lines = rest.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const sourceLine = /^(?:\*{1,2})?sources?\s*:/i;
  const articleLines = lines.filter(line => !sourceLine.test(line));
  const [headline, ...body] = articleLines;
  const embeds = message.embeds ?? [];
  const title = (headline && plainText(headline.replace(/^#{1,6}\s+/, ''))) ||
    embeds.find(embed => embed.title)?.title?.trim();
  const summary = body.map(line => plainText(line.replace(/^>+\s*/, ''))).filter(Boolean).join(' ')
    || embeds.find(embed => embed.description)?.description?.trim() || null;

  const links = new Set<string>();
  const addLink = (value: string | undefined) => {
    const url = articleUrl(value);
    if (url) links.add(url);
  };
  for (const line of [...lines.filter(line => sourceLine.test(line)), ...articleLines]) {
    marked.walkTokens(Lexer.lexInline(line), token => {
      if (token.type === 'link') addLink(token.href);
    });
  }
  for (const embed of embeds) addLink(embed.url);

  if (!title && !summary && !links.size && !message.attachments?.length) return null;
  const id = createHash('sha256').update(`${message.channel_id}/${message.id}`).digest('hex').slice(0, 32);
  const primaryLink = links.values().next().value;
  return {
    id,
    title: title || (primaryLink ? new URL(primaryLink).hostname : 'News update'),
    summary,
    raw_content: rest,
    category,
    publishedAt: new Date(message.timestamp).toISOString(),
    updatedAt: message.edited_timestamp ? new Date(message.edited_timestamp).toISOString() : null,
    links: [...links],
    attachments: (message.attachments ?? []).flatMap(attachment => {
      const url = articleUrl(attachment.url);
      return url ? [{ url, name: attachment.filename, contentType: attachment.content_type ?? null }] : [];
    }),
  };
}
