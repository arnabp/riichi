import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SeasonStore } from "./season.ts";
import { TournamentConfig } from "./tracker.ts";

const config: TournamentConfig = {
  tournamentId: "6980483",
  discordChannelId: "chan",
  statusChannelId: "status",
  label: "Spring League 2026",
};

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(resolve(tmpdir(), "season-test-"));
  file = resolve(dir, "season_state.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SeasonStore", () => {
  it("seeds season 1 from the env label when there is no state", async () => {
    const store = new SeasonStore(file);
    await store.load();
    const s = store.current(config);
    expect(s.seasonNumber).toBe(1);
    expect(s.label).toBe("Spring League 2026");
  });

  it("persists across reloads", async () => {
    const a = new SeasonStore(file);
    await a.load();
    await a.ensure(config);
    await a.update(config.tournamentId, { archivePath: "/tmp/x.json" });

    const b = new SeasonStore(file);
    await b.load();
    expect(b.current(config).archivePath).toBe("/tmp/x.json");
  });

  it("rollover bumps the season number and applies the new label", async () => {
    const store = new SeasonStore(file);
    await store.load();
    await store.ensure(config);

    const next = await store.rollover(config, "Summer League 2026", "/tmp/s01.json");
    expect(next.seasonNumber).toBe(2);
    expect(next.label).toBe("Summer League 2026");
    expect(next.endedAt).toBeUndefined();
    expect(next.archivePath).toBeUndefined();
  });

  it("resolve() overrides the stale env label with the live season label", async () => {
    // After a rollover the env still says "Spring League 2026"; posts must not.
    const store = new SeasonStore(file);
    await store.load();
    await store.ensure(config);
    await store.rollover(config, "Summer League 2026", "/tmp/s01.json");

    expect(store.resolve(config).label).toBe("Summer League 2026");
    expect(store.resolve(config).discordChannelId).toBe("chan");
  });

  it("survives repeated rollovers", async () => {
    const store = new SeasonStore(file);
    await store.load();
    await store.ensure(config);
    await store.rollover(config, "S2", "/a.json");
    await store.rollover(config, "S3", "/b.json");
    expect(store.current(config).seasonNumber).toBe(3);
    expect(store.current(config).label).toBe("S3");
  });

  it("keeps closed seasons and their archive pointers in history", async () => {
    // Seasons share one tournament id, so the closed record is the only thing
    // linking a past season to the archive holding its results.
    const store = new SeasonStore(file);
    await store.load();
    await store.ensure(config);
    await store.rollover(config, "Summer League 2026", "/archive/s01.json");
    await store.rollover(config, "Fall League 2026", "/archive/s02.json");

    const reloaded = new SeasonStore(file);
    await reloaded.load();
    const past = reloaded.past(config);
    expect(past.map((s) => s.label)).toEqual(["Spring League 2026", "Summer League 2026"]);
    expect(past.map((s) => s.archivePath)).toEqual(["/archive/s01.json", "/archive/s02.json"]);
    expect(past.every((s) => s.endedAt)).toBe(true);
  });

  it("update() refuses to patch a tournament it has never seen", async () => {
    const store = new SeasonStore(file);
    await store.load();
    await expect(store.update("nope", { archivePath: "x" })).rejects.toThrow();
  });
});
