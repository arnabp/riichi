import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { GameTracker, withSessionRetry, TournamentConfig } from "./tracker.ts";
import { RCGame, RiichiCityClient, SessionExpiredError } from "./riichicity.ts";

function makeMockClient(): RiichiCityClient {
  return {
    login: mock(() => Promise.resolve()),
  } as unknown as RiichiCityClient;
}

// ── markSeen / re-post de-duplication ────────────────────────────────────────

const config: TournamentConfig = {
  tournamentId: "t1",
  discordChannelId: "chan",
  label: "Season 2",
};

function game(id: string, endTime = 1000): RCGame {
  return {
    paiPuId: id,
    endTime,
    playerCount: 4,
    players: [{ uid: 1, nickname: "A", points: 25000, rank: 1 }],
  };
}

function clientReturning(games: RCGame[]): RiichiCityClient {
  return {
    enterTournament: async () => ({
      classifyId: "c1", matchId: 1, onlineSize: 0, ongoingGames: 0, queueSize: 0,
    }),
    getCompletedGames: async () => games,
  } as unknown as RiichiCityClient;
}

describe("GameTracker.markSeen", () => {
  let dir: string;
  let stateFile: string;
  let statusFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(resolve(tmpdir(), "tracker-test-"));
    stateFile = resolve(dir, "seen.json");
    statusFile = resolve(dir, "status.json");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function tracker(games: RCGame[]) {
    return new GameTracker(clientReturning(games), [config], stateFile, statusFile);
  }

  it("stops a re-posted game from being posted again by the next poll", async () => {
    // The scenario /season repost exists for: post the game by hand, then make
    // sure the poll loop does not duplicate it.
    const games = [game("g1")];
    const t = tracker(games);
    await t.init();
    await t.markSeen(["g1"]);
    expect(await t.poll()).toEqual([]);
  });

  it("still reports genuinely new games after a re-post", async () => {
    const games = [game("g1"), game("g2", 2000)];
    const t = tracker(games);
    await t.init();
    await t.markSeen(["g1"]);
    const found = await t.poll();
    expect(found.map((r) => r.game.paiPuId)).toEqual(["g2"]);
  });

  it("persists across a restart", async () => {
    const games = [game("g1")];
    const a = tracker(games);
    await a.init();
    await a.markSeen(["g1"]);

    const b = tracker(games);
    await b.init();
    expect(await b.poll()).toEqual([]);
  });

  it("is idempotent", async () => {
    const t = tracker([game("g1")]);
    await t.init();
    await t.markSeen(["g1"]);
    await t.markSeen(["g1"]);
    expect(await t.poll()).toEqual([]);
  });
});

describe("withSessionRetry", () => {
  it("calls fn once and does not login when no error", async () => {
    const client = makeMockClient();
    const fn = mock(() => Promise.resolve());
    await withSessionRetry(client, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.login).not.toHaveBeenCalled();
  });

  it("re-logs in and retries once on SessionExpiredError", async () => {
    const client = makeMockClient();
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls === 1) throw new SessionExpiredError("/test", 10001);
    });
    await withSessionRetry(client, fn);
    expect(client.login).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates non-session errors without retrying or re-logging in", async () => {
    const client = makeMockClient();
    const fn = mock(async () => { throw new Error("network failure"); });
    await expect(withSessionRetry(client, fn)).rejects.toThrow("network failure");
    expect(client.login).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("propagates SessionExpiredError if the retry also fails", async () => {
    const client = makeMockClient();
    const fn = mock(async () => { throw new SessionExpiredError("/test", 401); });
    await expect(withSessionRetry(client, fn)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(client.login).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates login failure without calling fn a second time", async () => {
    const client = {
      login: mock(async () => { throw new Error("login failed"); }),
    } as unknown as RiichiCityClient;
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls === 1) throw new SessionExpiredError("/test", 401);
    });
    await expect(withSessionRetry(client, fn)).rejects.toThrow("login failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
