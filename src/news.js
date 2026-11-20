import { createHash } from 'node:crypto';
import { MessageFlags } from 'discord.js';
import { Lexer, marked, Parser } from 'marked';

export const categories = ['nerds', 'nerds-ai'];

export function isFollowedPost(message, config) {
  if (message.channel_id !== config.channelId) return false;
  const source = message.message_reference?.channel_id;
  const isCrosspost = Boolean(message.flags & MessageFlags.IsCrosspost);
  if (isCrosspost && source && config.sourceChannelId) return source === config.sourceChannelId;
  return Boolean(config.followerWebhookId && message.webhook_id === config.followerWebhookId);
}

export function isSourceDeleted(message) {
  return Boolean(message.flags & MessageFlags.SourceMessageDeleted);
}

function readLabels(content, config) {
  const labels = new Set();
  let rest = content.trimStart();
  const prefix = /^(?:<@&(\d+)>|@(Nerds(?:[ \t]+AI)?)(?![\p{L}\p{N}_]))\s*/iu;
  for (let match; (match = prefix.exec(rest)); rest = rest.slice(match[0].length)) {
    const [, roleId, text] = match;
    if (text) labels.add(/ai$/i.test(text) ? 'nerds-ai' : 'nerds');
    else if (roleId === config.nerdsRoleId) labels.add('nerds');
    else if (roleId === config.nerdsAiRoleId) labels.add('nerds-ai');
    else labels.add(null);
  }
  return { rest, category: labels.size === 1 ? labels.values().next().value : null };
}

function plainText(text) {
  const discordText = text.replace(/<a?:([\w]+):\d+>/g, ':$1:').replace(/<[@#][!&]?\d+>/g, '');
  const parser = new Parser();
  return parser.parseInline(Lexer.lexInline(discordText), parser.textRenderer).replace(/\s+/g, ' ').trim();
}

function articleUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {
    // Ignore malformed links.
  }
  return null;
}

export function normalizePost(message, config) {
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

  const links = new Set();
  const addLink = value => {
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
  return {
    id,
    title: title || (links.size ? new URL(links.values().next().value).hostname : 'News update'),
    summary,
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
