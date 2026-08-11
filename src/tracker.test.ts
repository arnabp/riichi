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

// ── pollStatus: locally computed standings ───────────────────────────────────

describe("GameTracker.pollStatus", () => {
  let dir: string;

  const statusConfig: TournamentConfig = {
    tournamentId: "t1",
    discordChannelId: "chan",
    statusChannelId: "status",
    label: "Season 2",
  };

  function fullGame(id: string, endTime: number): RCGame {
    return {
      paiPuId: id,
      endTime,
      playerCount: 4,
      players: [
        { uid: 1, nickname: "A", points: 50000, rank: 1 },
        { uid: 2, nickname: "B", points: 30000, rank: 2 },
        { uid: 3, nickname: "C", points: 15000, rank: 3 },
        { uid: 4, nickname: "D", points: 5000, rank: 4 },
      ],
    };
  }

  // Client whose game history and leaderboard can be changed between polls, and
  // which counts how many pages of history it served.
  function stubClient(state: { games: RCGame[]; leaderboard: any[] }) {
    let pageCalls = 0;
    const client = {
      enterTournament: async () => ({
        classifyId: "c1", matchId: 1, onlineSize: 0, ongoingGames: 0, queueSize: 0,
      }),
      getCompletedGames: async () => state.games,
      getCompletedGamesPage: async (_c: string, skip: number) => {
        pageCalls++;
        const page = skip === 0 ? state.games : [];
        return { games: page, rawCount: page.length };
      },
      getLeaderboard: async () => state.leaderboard,
    } as unknown as RiichiCityClient;
    return { client, pages: () => pageCalls };
  }

  beforeEach(async () => { dir = await mkdtemp(resolve(tmpdir(), "tracker-status-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function tracker(client: RiichiCityClient) {
    return new GameTracker(
      client, [statusConfig], resolve(dir, "seen.json"), resolve(dir, "status.json")
    );
  }

  it("computes standings from the games, not from the tournament's rank score", async () => {
    const state = {
      games: [fullGame("g1", 1000)],
      // The tournament ranks D first with a wildly different score. Ignored.
      leaderboard: [{ rank: 1, userID: 4, nickname: "D", rankScore: 99999, gamesPlayed: 1 }],
    };
    const t = tracker(stubClient(state).client);
    await t.init();
    const [{ status }] = await t.pollStatus();

    expect(status.standings.map((s) => s.nickname)).toEqual(["A", "B", "C", "D"]);
    expect(status.standings[0].points).toBeCloseTo(40, 6); // (50000-25000)/1000 + 15
    expect(status.standings.reduce((sum, s) => sum + s.points, 0)).toBeCloseTo(0, 6);
    // Still carried, for the caller that wants to compare.
    expect(status.leaderboard[0].rankScore).toBe(99999);
  });

  it("does not re-page the whole history when nothing has changed", async () => {
    const state = {
      games: [fullGame("g1", 1000)],
      leaderboard: [{ rank: 1, userID: 1, nickname: "A", rankScore: 400, gamesPlayed: 1 }],
    };
    const stub = stubClient(state);
    const t = tracker(stub.client);
    await t.init();

    await t.pollStatus();
    const afterFirst = stub.pages();
    await t.pollStatus();
    await t.pollStatus();
    expect(stub.pages()).toBe(afterFirst);
  });

  it("recomputes once the tournament's leaderboard moves", async () => {
    const state = {
      games: [fullGame("g1", 1000)],
      leaderboard: [{ rank: 1, userID: 1, nickname: "A", rankScore: 400, gamesPlayed: 1 }],
    };
    const stub = stubClient(state);
    const t = tracker(stub.client);
    await t.init();
    await t.pollStatus();

    // A second game finishes: the tournament's leaderboard moves, which is the
    // signal that the league table needs recomputing.
    state.games = [fullGame("g1", 1000), fullGame("g2", 2000)];
    state.leaderboard = [{ rank: 1, userID: 1, nickname: "A", rankScore: 800, gamesPlayed: 2 }];
    const [{ status }] = await t.pollStatus();

    expect(status.standings[0].gamesPlayed).toBe(2);
    expect(status.standings[0].points).toBeCloseTo(80, 6);
  });

  it("drops the cached table when the season is reset", async () => {
    const state = {
      games: [fullGame("g1", 1000)],
      leaderboard: [{ rank: 1, userID: 1, nickname: "A", rankScore: 400, gamesPlayed: 1 }],
    };
    const stub = stubClient(state);
    const t = tracker(stub.client);
    await t.init();
    await t.pollStatus();

    // A rollover empties the tournament while its leaderboard is still cached.
    await t.resetSeason("t1", ["g1"]);
    state.games = [];
    const [{ status }] = await t.pollStatus();
    expect(status.standings).toEqual([]);
  });
});
