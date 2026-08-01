import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { GuildTextBasedChannel } from "discord.js";
import { dumpChannel, purgeChannel, purgeChannelSafely, PurgeRefused } from "./purge.ts";

const DAY = 24 * 60 * 60 * 1000;

interface FakeMsg {
  id: string;
  createdTimestamp: number;
  content: string;
  author: { id: string; tag: string; bot: boolean };
  embeds: { toJSON: () => object }[];
  attachments: Map<string, { url: string }>;
  delete: () => Promise<void>;
  deleted?: boolean;
}

function msg(
  id: string,
  ageDays: number,
  opts: { content?: string; bot?: boolean; undeletable?: boolean } = {},
): FakeMsg {
  const m: FakeMsg = {
    id,
    createdTimestamp: Date.now() - ageDays * DAY,
    content: opts.content ?? `message ${id}`,
    author: { id: "u1", tag: "user#1", bot: opts.bot ?? false },
    embeds: [],
    attachments: new Map(),
    delete: async () => {
      if (opts.undeletable) throw new Error("Missing Permissions");
      m.deleted = true;
    },
  };
  return m;
}

// Minimal stand-in for a Discord text channel: fetch() pages newest-first via
// `before`, and bulkDelete removes from the backing store.
function fakeChannel(initial: FakeMsg[], name = "results"): GuildTextBasedChannel {
  let store = [...initial].sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  const collection = (items: FakeMsg[]) => {
    const map = new Map(items.map((m) => [m.id, m]));
    return Object.assign(map, {
      last: () => items[items.length - 1],
      filter: (fn: (m: FakeMsg) => boolean) => collection(items.filter(fn)),
    });
  };

  return {
    id: "chan1",
    name,
    messages: {
      fetch: async ({ limit, before }: { limit: number; before?: string }) => {
        let pool = store;
        if (before) {
          const idx = pool.findIndex((m) => m.id === before);
          pool = idx >= 0 ? pool.slice(idx + 1) : [];
        }
        return collection(pool.slice(0, limit));
      },
    },
    bulkDelete: async (msgs: Map<string, FakeMsg>) => {
      const ids = new Set(msgs.keys());
      store = store.filter((m) => !ids.has(m.id));
      return msgs;
    },
    // purgeChannel deletes old messages individually; reflect that in the store
    // so the next fetch makes progress.
    __removeDeleted: () => { store = store.filter((m) => !m.deleted); },
  } as unknown as GuildTextBasedChannel;
}

// Individual deletes only flip a flag on the fake; drop them from the store
// between fetches the way Discord would.
function selfPruning(initial: FakeMsg[], name?: string): GuildTextBasedChannel {
  const channel = fakeChannel(initial, name) as GuildTextBasedChannel & { __removeDeleted: () => void };
  const realFetch = channel.messages.fetch.bind(channel.messages);
  (channel.messages as { fetch: unknown }).fetch = async (opts: { limit: number; before?: string }) => {
    channel.__removeDeleted();
    return realFetch(opts as never);
  };
  return channel;
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(resolve(tmpdir(), "purge-test-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("dumpChannel", () => {
  it("captures every message oldest-first", async () => {
    const dump = await dumpChannel(selfPruning([msg("a", 3), msg("b", 1), msg("c", 2)]));
    expect(dump.messages.map((m) => m.id)).toEqual(["a", "c", "b"]);
    expect(dump.messageCount).toBe(3);
  });

  it("flags an incomplete dump when a human message has no readable content", async () => {
    // What Discord returns when the MessageContent intent is off.
    const dump = await dumpChannel(selfPruning([msg("a", 1, { content: "" })]));
    expect(dump.contentMayBeIncomplete).toBe(true);
  });

  it("does not flag bot messages with empty content", async () => {
    // The bot's own embeds come through regardless of the intent.
    const dump = await dumpChannel(selfPruning([msg("a", 1, { content: "", bot: true })]));
    expect(dump.contentMayBeIncomplete).toBe(false);
  });
});

describe("purgeChannel", () => {
  it("bulk-deletes recent messages and slow-deletes old ones", async () => {
    const channel = selfPruning([msg("new", 1), msg("old", 30)]);
    const result = await purgeChannel(channel, undefined, 0);
    expect(result.bulkDeleted).toBe(1);
    expect(result.slowDeleted).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("empties a channel of only old messages", async () => {
    const msgs = Array.from({ length: 5 }, (_, i) => msg(`m${i}`, 30));
    const channel = selfPruning(msgs);
    const result = await purgeChannel(channel, undefined, 0);
    expect(result.slowDeleted).toBe(5);
    expect((await channel.messages.fetch({ limit: 100 })).size).toBe(0);
  });

  it("terminates instead of looping when a message cannot be deleted", async () => {
    const channel = selfPruning([msg("stuck", 30, { undeletable: true })]);
    const result = await purgeChannel(channel, undefined, 0);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.slowDeleted).toBe(0);
  });

  it("is a no-op on an empty channel", async () => {
    const result = await purgeChannel(selfPruning([]), undefined, 0);
    expect(result).toEqual({ bulkDeleted: 0, slowDeleted: 0, failed: 0 });
  });
});

describe("purgeChannelSafely", () => {
  it("writes a verified backup before deleting anything", async () => {
    const channel = selfPruning([msg("a", 30, { bot: true }), msg("b", 1, { bot: true })]);
    const { dumpPath, dump, purge } = await purgeChannelSafely(channel, "s01", { dir, delayMs: 0 });

    expect(dump.messageCount).toBe(2);
    expect(purge.bulkDeleted + purge.slowDeleted).toBe(2);

    const saved = JSON.parse(await Bun.file(dumpPath).text());
    expect(saved.messages).toHaveLength(2);
    expect((await readdir(resolve(dir, "channels"))).length).toBe(1);
  });

  it("refuses to purge — and deletes nothing — when the backup would be incomplete", async () => {
    // The whole point: once the tournament resets these messages are the only
    // record, so an unreadable message must block the purge.
    const messages = [msg("a", 30, { content: "" })];
    const channel = selfPruning(messages);

    await expect(purgeChannelSafely(channel, "s01", { dir, delayMs: 0 }))
      .rejects.toBeInstanceOf(PurgeRefused);

    expect((await channel.messages.fetch({ limit: 100 })).size).toBe(1);
    await expect(readdir(resolve(dir, "channels"))).rejects.toThrow(); // no backup written
  });
});
