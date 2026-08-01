import { describe, it, expect } from "bun:test";
import { summarize, formatRankScore, standingsTable } from "./stats.ts";
import { SeasonArchive } from "./archive.ts";
import { RCGame } from "./riichicity.ts";

// Four players, scores summing to 100000 as real games do.
function game(id: string, endTime: number, order: [string, number][]): RCGame {
  return {
    paiPuId: id,
    endTime,
    playerCount: 4,
    players: order.map(([nickname, points], i) => ({
      uid: nameToUid(nickname),
      nickname,
      points,
      rank: i + 1,
    })),
  };
}

const uids: Record<string, number> = { A: 1, B: 2, C: 3, D: 4 };
function nameToUid(n: string): number {
  return uids[n] ?? 99;
}

function archive(games: RCGame[], leaderboard: SeasonArchive["finalLeaderboard"] = []): SeasonArchive {
  return {
    seasonLabel: "Test Season",
    seasonNumber: 1,
    tournamentId: "t1",
    classifyId: "c1",
    matchId: 1,
    archivedAt: "2026-07-31T00:00:00.000Z",
    games,
    finalLeaderboard: leaderboard,
  };
}

describe("summarize", () => {
  const games = [
    game("g1", 1000, [["A", 50000], ["B", 30000], ["C", 15000], ["D", 5000]]),
    game("g2", 2000, [["B", 45000], ["A", 35000], ["D", 25000], ["C", -5000]]),
  ];

  it("counts games and placements per player", () => {
    const s = summarize(archive(games));
    const a = s.players.find((p) => p.nickname === "A")!;
    expect(a.gamesPlayed).toBe(2);
    expect(a.placements).toEqual([1, 1, 0, 0]);
    expect(a.avgPlacement).toBe(1.5);
  });

  it("computes rate metrics", () => {
    const s = summarize(archive(games));
    const c = s.players.find((p) => p.nickname === "C")!;
    expect(c.placements).toEqual([0, 0, 1, 1]);
    expect(c.firstRate).toBe(0);
    expect(c.lastRate).toBe(0.5);
    expect(c.bustRate).toBe(0.5); // the -5000 finish
    expect(c.rentaiRate).toBe(0);
  });

  it("totals and averages end scores", () => {
    const s = summarize(archive(games));
    const a = s.players.find((p) => p.nickname === "A")!;
    expect(a.totalPoints).toBe(85000);
    expect(a.avgPoints).toBe(42500);
  });

  it("tracks best and worst single games", () => {
    const s = summarize(archive(games));
    const c = s.players.find((p) => p.nickname === "C")!;
    expect(c.bestGame.points).toBe(15000);
    expect(c.worstGame.points).toBe(-5000);
  });

  it("reports season-wide extremes", () => {
    const s = summarize(archive(games));
    expect(s.totalGames).toBe(2);
    expect(s.highestScore).toMatchObject({ nickname: "A", points: 50000 });
    expect(s.lowestScore).toMatchObject({ nickname: "C", points: -5000 });
    expect(s.firstGameAt).toBe(1000);
    expect(s.lastGameAt).toBe(2000);
  });

  it("uses the most recent nickname when a player renames mid-season", () => {
    const renamed = [
      game("g1", 1000, [["A", 50000], ["B", 30000], ["C", 15000], ["D", 5000]]),
      // Same uid as A (nameToUid falls back to 99 only for unknown names), so
      // build the rename explicitly.
      {
        paiPuId: "g2",
        endTime: 2000,
        playerCount: 4,
        players: [
          { uid: 1, nickname: "A-newname", points: 40000, rank: 1 },
          { uid: 2, nickname: "B", points: 30000, rank: 2 },
          { uid: 3, nickname: "C", points: 20000, rank: 3 },
          { uid: 4, nickname: "D", points: 10000, rank: 4 },
        ],
      } as RCGame,
    ];
    const s = summarize(archive(renamed));
    const a = s.players.find((p) => p.uid === 1)!;
    expect(a.nickname).toBe("A-newname");
    expect(a.gamesPlayed).toBe(2);
  });

  it("orders by official leaderboard rank and carries rankScore", () => {
    const s = summarize(archive(games, [
      { rank: 1, userID: 3, nickname: "C", rankScore: 900, gamesPlayed: 2 },
      { rank: 2, userID: 1, nickname: "A", rankScore: 500, gamesPlayed: 2 },
    ]));
    expect(s.players[0].nickname).toBe("C");
    expect(s.players[0].rankScore).toBe(900);
    expect(s.players[1].nickname).toBe("A");
    // Players absent from the leaderboard sort below those on it.
    expect(s.players.slice(2).every((p) => p.leaderboardRank == null)).toBe(true);
  });

  it("handles an empty season without throwing", () => {
    const s = summarize(archive([]));
    expect(s.totalGames).toBe(0);
    expect(s.players).toEqual([]);
    expect(s.highestScore).toBeUndefined();
    expect(s.firstGameAt).toBeUndefined();
  });
});

describe("formatRankScore", () => {
  // The API stores rank score with one implied decimal: the Riichi City client
  // renders a stored 12600 as "1260.0", and the bot has to match it.
  it("shifts the implied decimal place", () => {
    expect(formatRankScore(12600)).toBe("1,260.0");
    expect(formatRankScore(5962)).toBe("596.2");
  });

  it("handles negative scores", () => {
    expect(formatRankScore(-11843)).toBe("-1,184.3");
    expect(formatRankScore(-309)).toBe("-30.9");
  });

  it("always shows exactly one decimal place", () => {
    expect(formatRankScore(0)).toBe("0.0");
    expect(formatRankScore(2390)).toBe("239.0");
    expect(formatRankScore(5)).toBe("0.5");
  });

  it("does not lose precision on values that are inexact in binary", () => {
    expect(formatRankScore(1016)).toBe("101.6");
    expect(formatRankScore(-1453)).toBe("-145.3");
  });
});

describe("standingsTable", () => {
  it("renders rank score in client units, not raw API units", () => {
    const s = summarize(archive(
      [game("g1", 1000, [["A", 50000], ["B", 30000], ["C", 15000], ["D", 5000]])],
      [{ rank: 1, userID: 1, nickname: "A", rankScore: 12600, gamesPlayed: 1 }],
    ));
    const table = standingsTable(s);
    expect(table).toContain("1,260.0");
    expect(table).not.toContain("12,600");
  });

  it("stays narrow enough for a Discord embed", () => {
    // Embeds have a fixed maximum width and wrap badly past ~55 monospace
    // characters, so the table must not grow new columns unchecked.
    const games = Array.from({ length: 40 }, (_, i) =>
      game(`g${i}`, 1000 + i, [["A", 50000], ["B", 30000], ["C", 15000], ["D", 5000]]));
    const s = summarize(archive(games, [
      { rank: 1, userID: 1, nickname: "averyverylongname", rankScore: -112345, gamesPlayed: 40 },
    ]));
    for (const line of standingsTable(s).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(55);
    }
  });

  it("omits games played, which is recoverable from the placement counts", () => {
    const s = summarize(archive(
      [game("g1", 1000, [["A", 50000], ["B", 30000], ["C", 15000], ["D", 5000]])]
    ));
    expect(standingsTable(s)).toContain("1/2/3/4");
    expect(standingsTable(s)).not.toContain(" G ");
  });

  it("leaves per-game scores unscaled", () => {
    // Game points are true mahjong end scores and must not be shifted.
    const s = summarize(archive(
      [game("g1", 1000, [["A", 50000], ["B", 30000], ["C", 15000], ["D", 5000]])]
    ));
    expect(s.players[0].avgPoints).toBe(50000);
    expect(s.highestScore!.points).toBe(50000);
  });
});
