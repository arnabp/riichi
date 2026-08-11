import { describe, it, expect } from "bun:test";
import { summarize, formatRankScore, standingsTable, standings } from "./stats.ts";
import { SeasonArchive } from "./archive.ts";
import { RCGame } from "./riichicity.ts";
import { SPRING_2026_SETTINGS } from "./scoring.ts";

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

function archive(
  games: RCGame[],
  leaderboard: SeasonArchive["finalLeaderboard"] = [],
  settings?: SeasonArchive["settings"],
): SeasonArchive {
  return {
    seasonLabel: "Test Season",
    seasonNumber: 1,
    tournamentId: "t1",
    classifyId: "c1",
    matchId: 1,
    archivedAt: "2026-07-31T00:00:00.000Z",
    settings,
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

  it("orders by the league standing, not the tournament's leaderboard", () => {
    // The tournament here ranks C first; the league's own scoring of the same
    // games puts C last. Discord follows the league — that is the whole point
    // of computing standings rather than reading rankScore.
    const s = summarize(archive(games, [
      { rank: 1, userID: 3, nickname: "C", rankScore: 900, gamesPlayed: 2 },
      { rank: 2, userID: 1, nickname: "A", rankScore: 500, gamesPlayed: 2 },
    ]));
    expect(s.players.map((p) => p.nickname)).toEqual(["A", "B", "D", "C"]);
    expect(s.players.map((p) => p.rank)).toEqual([1, 2, 3, 4]);
    expect(s.players[0].leaguePoints).toBeCloseTo(55, 6);
  });

  it("carries the tournament's own numbers alongside, for reference", () => {
    const s = summarize(archive(games, [
      { rank: 1, userID: 3, nickname: "C", rankScore: 900, gamesPlayed: 2 },
    ]));
    const c = s.players.find((p) => p.nickname === "C")!;
    expect(c.rankScore).toBe(900);
    expect(c.leaderboardRank).toBe(1);
    // Players the tournament never ranked still get a league standing.
    const b = s.players.find((p) => p.nickname === "B")!;
    expect(b.leaderboardRank).toBeUndefined();
    expect(b.rank).toBe(2);
  });

  it("gives everyone a standing, and every table sums to zero", () => {
    const s = summarize(archive(games));
    const total = s.players.reduce((sum, p) => sum + p.leaguePoints, 0);
    expect(total).toBeCloseTo(0, 6);
    expect(s.players.every((p) => Number.isFinite(p.leaguePoints))).toBe(true);
  });

  it("scores a finished season under the settings it was played under", () => {
    // Spring League 2026 was played with a 30,000 return, a 20 oka and heavier
    // uma. Re-scoring it under today's settings would rewrite history, so the
    // archive carries its own and summarize() uses them.
    const asPlayed = summarize(archive(games, [], SPRING_2026_SETTINGS));
    expect(asPlayed.players[0].leaguePoints).toBeCloseTo(85, 6); // (20+50) + (5+10)

    // Same games, no recorded settings: falls back to the current ones.
    expect(summarize(archive(games)).players[0].leaguePoints).toBeCloseTo(55, 6);
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
  it("shows the league's own points, not the tournament's rank score", () => {
    const s = summarize(archive(
      [game("g1", 1000, [["A", 50000], ["B", 30000], ["C", 15000], ["D", 5000]])],
      [{ rank: 1, userID: 1, nickname: "A", rankScore: 12600, gamesPlayed: 1 }],
    ));
    const table = standingsTable(s);
    expect(table).toContain("+40.0");   // (50000-25000)/1000 + 15 uma
    expect(table).not.toContain("1,260.0");
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

describe("standings", () => {
  const games = [
    game("g1", 1000, [["A", 50000], ["B", 30000], ["C", 15000], ["D", 5000]]),
    game("g2", 2000, [["B", 45000], ["A", 35000], ["D", 25000], ["C", -5000]]),
  ];

  it("totals league points from raw table scores", () => {
    const table = standings(games);
    // A: (25 + 15) then (10 + 5).  B: (5 + 5) then (20 + 15).
    expect(table.find((s) => s.nickname === "A")!.points).toBeCloseTo(55, 6);
    expect(table.find((s) => s.nickname === "B")!.points).toBeCloseTo(45, 6);
  });

  it("orders by points and ranks from 1", () => {
    expect(standings(games).map((s) => [s.nickname, s.rank])).toEqual([
      ["A", 1], ["B", 2], ["D", 3], ["C", 4],
    ]);
  });

  it("sums to zero under a balanced ruleset", () => {
    expect(standings(games).reduce((sum, s) => sum + s.points, 0)).toBeCloseTo(0, 6);
  });

  it("counts games played per player", () => {
    expect(standings(games).every((s) => s.gamesPlayed === 2)).toBe(true);
  });

  it("honours the settings it is given", () => {
    const flat = { returnPoints: 25_000, oka: 0, uma: [0, 0, 0, 0] };
    // Without uma, points are just the margin above the starting score.
    expect(standings(games, flat).find((s) => s.nickname === "A")!.points).toBeCloseTo(35, 6);
  });

  it("gives tied totals the same rank and skips the next place", () => {
    // A and B swap 1st and 2nd with mirrored scores, so they finish level.
    const mirrored = [
      game("m1", 1000, [["A", 40000], ["B", 30000], ["C", 20000], ["D", 10000]]),
      game("m2", 2000, [["B", 40000], ["A", 30000], ["D", 20000], ["C", 10000]]),
    ];
    expect(standings(mirrored).map((s) => s.rank)).toEqual([1, 1, 3, 3]);
  });

  it("keeps the most recent nickname when a player renames", () => {
    const renamed = [
      game("g1", 1000, [["A", 50000], ["B", 30000], ["C", 15000], ["D", 5000]]),
      {
        paiPuId: "g2", endTime: 2000, playerCount: 4,
        players: [
          { uid: 1, nickname: "A-newname", points: 40000, rank: 1 },
          { uid: 2, nickname: "B", points: 30000, rank: 2 },
          { uid: 3, nickname: "C", points: 20000, rank: 3 },
          { uid: 4, nickname: "D", points: 10000, rank: 4 },
        ],
      } as RCGame,
    ];
    expect(standings(renamed).find((s) => s.uid === 1)!.nickname).toBe("A-newname");
  });

  it("handles an empty season", () => {
    expect(standings([])).toEqual([]);
  });
});
