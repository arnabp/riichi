import { resolve } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import type { Message, GuildTextBasedChannel } from "discord.js";
import { ARCHIVE_DIR } from "./archive.ts";

const FETCH_PAGE = 100;
// Discord only bulk-deletes messages newer than 14 days; anything older has to
// go one at a time.
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SLOW_DELETE_DELAY_MS = 1_100;

export interface DumpedMessage {
  id: string;
  authorId: string;
  authorTag: string;
  bot: boolean;
  createdAt: string;
  content: string;
  embeds: unknown[];
  attachments: string[];
}

export interface ChannelDump {
  channelId: string;
  channelName: string;
  dumpedAt: string;
  messageCount: number;
  // True when at least one non-bot message came back with empty content, which
  // means the MessageContent privileged intent is off and human posts were not
  // fully captured. Purging on a partial dump is refused.
  contentMayBeIncomplete: boolean;
  messages: DumpedMessage[]; // oldest first
}

// Read a channel's entire history into memory, oldest first.
export async function dumpChannel(
  channel: GuildTextBasedChannel,
  onProgress?: (n: number) => void,
): Promise<ChannelDump> {
  const collected: Message[] = [];
  let before: string | undefined;

  for (;;) {
    const batch = await channel.messages.fetch({ limit: FETCH_PAGE, before });
    if (batch.size === 0) break;
    collected.push(...batch.values());
    onProgress?.(collected.length);
    before = batch.last()!.id;
    if (batch.size < FETCH_PAGE) break;
  }

  collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const messages: DumpedMessage[] = collected.map((m) => ({
    id: m.id,
    authorId: m.author.id,
    authorTag: m.author.tag,
    bot: m.author.bot,
    createdAt: new Date(m.createdTimestamp).toISOString(),
    content: m.content,
    embeds: m.embeds.map((e) => e.toJSON()),
    attachments: [...m.attachments.values()].map((a) => a.url),
  }));

  const contentMayBeIncomplete = messages.some(
    (m) => !m.bot && m.content === "" && m.embeds.length === 0 && m.attachments.length === 0
  );

  return {
    channelId: channel.id,
    channelName: channel.name,
    dumpedAt: new Date().toISOString(),
    messageCount: messages.length,
    contentMayBeIncomplete,
    messages,
  };
}

export async function saveChannelDump(
  dump: ChannelDump,
  seasonSlug: string,
  dir = ARCHIVE_DIR,
): Promise<string> {
  const target = resolve(dir, "channels");
  await mkdir(target, { recursive: true });
  const path = resolve(target, `${seasonSlug}-${dump.channelName}-${dump.channelId}.json`);
  const tmp = path + ".tmp";
  await Bun.write(tmp, JSON.stringify(dump, null, 2));
  await rename(tmp, path);
  return path;
}

export interface PurgeResult {
  bulkDeleted: number;
  slowDeleted: number;
  failed: number;
}

// Delete every message in a channel. Callers must have dumped it first —
// this function does not check, but purgeChannelSafely does.
export async function purgeChannel(
  channel: GuildTextBasedChannel,
  onProgress?: (deleted: number, total: number) => void,
  delayMs = SLOW_DELETE_DELAY_MS,
): Promise<PurgeResult> {
  const result: PurgeResult = { bulkDeleted: 0, slowDeleted: 0, failed: 0 };
  let total = 0;

  for (;;) {
    const batch = await channel.messages.fetch({ limit: FETCH_PAGE });
    if (batch.size === 0) break;
    total += batch.size;

    const cutoff = Date.now() - BULK_DELETE_MAX_AGE_MS;
    const recent = batch.filter((m) => m.createdTimestamp > cutoff);
    const old = batch.filter((m) => m.createdTimestamp <= cutoff);

    if (recent.size > 0) {
      const deleted = await channel.bulkDelete(recent, true);
      result.bulkDeleted += deleted.size;
      onProgress?.(result.bulkDeleted + result.slowDeleted, total);
    }

    for (const msg of old.values()) {
      try {
        await msg.delete();
        result.slowDeleted++;
      } catch {
        // Already gone, or we lack permission on this one — keep going so a
        // single stuck message can't strand the rest of the purge.
        result.failed++;
      }
      onProgress?.(result.bulkDeleted + result.slowDeleted, total);
      if (delayMs > 0) await Bun.sleep(delayMs);
    }

    // Nothing removable left (all failures) — stop rather than loop forever.
    if (recent.size === 0 && old.size === 0) break;
    if (result.failed >= batch.size && recent.size === 0) break;
  }

  return result;
}

export class PurgeRefused extends Error {}

// Dump first, verify the dump, then delete. Refuses to purge anything it could
// not fully capture — once the tournament resets, these messages are the only
// remaining record.
export async function purgeChannelSafely(
  channel: GuildTextBasedChannel,
  seasonSlug: string,
  opts: {
    onDump?: (n: number) => void;
    onDelete?: (d: number, t: number) => void;
    dir?: string;
    delayMs?: number;
  } = {},
): Promise<{ dumpPath: string; dump: ChannelDump; purge: PurgeResult }> {
  const dump = await dumpChannel(channel, opts.onDump);

  if (dump.contentMayBeIncomplete) {
    throw new PurgeRefused(
      `Refusing to purge #${channel.name}: some human-authored messages came back with no ` +
      `content, which means the MessageContent intent is disabled. Enable it in the Discord ` +
      `developer portal (Bot → Privileged Gateway Intents) so the backup is complete, then retry.`
    );
  }

  const dumpPath = await saveChannelDump(dump, seasonSlug, opts.dir);

  // Re-read what we just wrote; a truncated backup is worse than no purge.
  const verify = JSON.parse(await Bun.file(dumpPath).text()) as ChannelDump;
  if (verify.messageCount !== dump.messageCount || verify.messages.length !== dump.messages.length) {
    throw new PurgeRefused(`Refusing to purge #${channel.name}: backup at ${dumpPath} did not verify.`);
  }

  const purge = await purgeChannel(channel, opts.onDelete, opts.delayMs);
  return { dumpPath, dump, purge };
}
