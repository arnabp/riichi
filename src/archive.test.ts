import { describe, it, expect } from "bun:test";
import { fetchAllGames, buildArchive, archiveFilename, SeasonArchive } from "./archive.ts";
import { SETTINGS } from "./scoring.ts";
import { RCGame, RiichiCityClient } from "./riichicity.ts";

function game(id: string, endTime: number): RCGame {
  return {
    paiPuId: id,
    endTime,
    playerCount: 4,
    players: [{ uid: 1, nickname: "A", points: 25000, rank: 1 }],
  };
}

// Client stub whose pages are scripted as [games, rawCount] pairs.
function clientWithPages(pages: [RCGame[], number][]): RiichiCityClient {
  let call = 0;
  return {
    getCompletedGamesPage: async () => {
      const page = pages[call++] ?? [[], 0];
      return { games: page[0], rawCount: page[1] };
    },
  } as unknown as RiichiCityClient;
}

describe("fetchAllGames", () => {
  it("pages until the server returns nothing", async () => {
    const client = clientWithPages([
      [[game("a", 3), game("b", 1)], 2],
      [[game("c", 2)], 1],
      [[], 0],
    ]);
    const games = await fetchAllGames(client, "cls");
    expect(games.map((g) => g.paiPuId)).toEqual(["b", "c", "a"]); // oldest first
  });

  it("keeps paging past a page whose games were all filtered out", async () => {
    // A page of abandoned games yields zero usable games but more history follows.
    // Stopping on games.length === 0 here would silently truncate the archive.
    const client = clientWithPages([
      [[game("a", 1)], 1],
      [[], 20],            // all 20 entries were mid-game pauses
      [[game("b", 2)], 1],
      [[], 0],
    ]);
    const games = await fetchAllGames(client, "cls");
    expect(games.map((g) => g.paiPuId)).toEqual(["a", "b"]);
  });

  it("de-duplicates games repeated across pages", async () => {
    const client = clientWithPages([
      [[game("a", 1), game("b", 2)], 2],
      [[game("b", 2), game("c", 3)], 2],
      [[], 0],
    ]);
    const games = await fetchAllGames(client, "cls");
    expect(games.map((g) => g.paiPuId)).toEqual(["a", "b", "c"]);
  });

  it("reports progress as games accumulate", async () => {
    const client = clientWithPages([
      [[game("a", 1)], 1],
      [[game("b", 2)], 1],
      [[], 0],
    ]);
    const seen: number[] = [];
    await fetchAllGames(client, "cls", (n) => seen.push(n));
    expect(seen).toEqual([1, 2, 2]);
  });

  it("returns empty for a tournament with no games", async () => {
    expect(await fetchAllGames(clientWithPages([[[], 0]]), "cls")).toEqual([]);
  });
});

describe("archiveFilename", () => {
  const base: SeasonArchive = {
    seasonLabel: "Spring League 2026",
    seasonNumber: 1,
    tournamentId: "6980483",
    classifyId: "c",
    matchId: 1,
    archivedAt: "",
    games: [],
    finalLeaderboard: [],
  };

  it("slugifies the label and zero-pads the season", () => {
    expect(archiveFilename(base)).toBe("s01-spring-league-2026.json");
  });

  it("keeps successive seasons on one tournament from colliding", () => {
    // Seasons reuse the same tournament id, so the season number is the only
    // thing preventing the next season from overwriting this archive.
    const next = { ...base, seasonNumber: 2, seasonLabel: "Spring League 2026" };
    expect(archiveFilename(next)).not.toBe(archiveFilename(base));
  });

  it("falls back to 'season' when the label has no usable characters", () => {
    expect(archiveFilename({ ...base, seasonLabel: "!!!" })).toBe("s01-season.json");
  });
});

describe("buildArchive", () => {
  const client = {
    enterTournament: async () => ({
      classifyId: "c1", matchId: 7, onlineSize: 0, ongoingGames: 0, queueSize: 0,
    }),
    getCompletedGamesPage: async (_c: string, skip: number) => {
      const page = skip === 0 ? [game("a", 1)] : [];
      return { games: page, rawCount: page.length };
    },
    getLeaderboard: async () => [
      { rank: 1, userID: 1, nickname: "A", rankScore: 400, gamesPlayed: 1 },
    ],
  } as unknown as RiichiCityClient;

  const config = { tournamentId: "t1", discordChannelId: "chan", label: "Test Season" };

  it("stamps the settings the season was played under", async () => {
    // Standings are recomputed from raw scores, so an archive without this
    // would be re-scored under whatever the rules become later.
    const archive = await buildArchive(client, config, 2);
    expect(archive.settings).toEqual(SETTINGS);
  });

  it("records the games and the tournament's own leaderboard", async () => {
    const archive = await buildArchive(client, config, 2);
    expect(archive.games.map((g) => g.paiPuId)).toEqual(["a"]);
    expect(archive.finalLeaderboard[0].rankScore).toBe(400);
    expect(archive.seasonNumber).toBe(2);
    expect(archive.matchId).toBe(7);
  });
});
