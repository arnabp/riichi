import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import {
  recalculate,
  parseUma,
  sameSettings,
  describeSettings,
  whatIfTable,
  balanceWarning,
} from "./whatif.ts";
import { SPRING_2026_SETTINGS as S1, SEASON_2_SETTINGS as S2 } from "./scoring.ts";
import { loadArchive } from "./archive.ts";
import { RCGame } from "./riichicity.ts";

// One table, four players, scores summing to the 100,000 a real game does.
function game(id: string, endTime: number, scores: [number, number][]): RCGame {
  return {
    paiPuId: id,
    endTime,
    playerCount: 4,
    players: scores.map(([uid, points], i) => ({
      uid,
      nickname: `p${uid}`,
      points,
      rank: i + 1,
    })),
  };
}

// Built so the two rulesets disagree: uid 1 wins big and busts out last, uid 2
// scrapes a 1st and a 2nd. Heavier uma rewards uid 2's placements enough to
// overturn uid 1's 28,100-point lead on raw score.
const GAMES: RCGame[] = [
  game("g1", 100, [[1, 50_000], [2, 20_000], [3, 18_000], [4, 12_000]]),
  game("g2", 200, [[2, 26_000], [3, 25_000], [4, 24_900], [1, 24_100]]),
];

describe("parseUma", () => {
  it("takes four explicit values", () => {
    expect(parseUma("30,10,-10,-30")).toEqual([30, 10, -10, -30]);
  });

  it("mirrors the two-value shorthand", () => {
    expect(parseUma("30,10")).toEqual([30, 10, -10, -30]);
  });

  it("accepts slashes and spaces as separators", () => {
    expect(parseUma("15/5/-5/-15")).toEqual([15, 5, -5, -15]);
    expect(parseUma("  20 10 -10 -20 ")).toEqual([20, 10, -10, -20]);
  });

  it("allows asymmetric uma", () => {
    expect(parseUma("40,10,-10,-40")).toEqual([40, 10, -10, -40]);
    expect(parseUma("30,0,0,-30")).toEqual([30, 0, 0, -30]);
  });

  it("rejects the wrong number of values", () => {
    expect(() => parseUma("30,10,-10")).toThrow();
    expect(() => parseUma("")).toThrow();
  });

  it("rejects non-numbers", () => {
    expect(() => parseUma("30,ten,-10,-30")).toThrow();
  });
});

describe("recalculate", () => {
  it("totals each player under both rulesets", () => {
    const result = recalculate(GAMES, S1, S2);
    const byUid = new Map(result.rows.map((r) => [r.uid, r]));

    // uid 1: 1st with 50,000 then 4th with 24,100.
    // S1: (20 + 30 + 20) + (-5.9 - 30) = 34.1.  S2: (20 + 15) + (-5.9 - 15) = 14.1.
    expect(byUid.get(1)!.points).toBeCloseTo(34.1, 6);
    expect(byUid.get(1)!.basePoints).toBeCloseTo(14.1, 6);
    expect(byUid.get(1)!.pointsDelta).toBeCloseTo(20, 6);
    expect(byUid.get(1)!.gamesPlayed).toBe(2);
  });

  it("re-ranks on the proposed totals and reports the movement", () => {
    // uid 1 leads under the current (lighter) uma; the heavier uma flips it.
    const result = recalculate(GAMES, S1, S2);
    expect(result.rows.map((r) => r.uid)).toEqual([2, 1, 3, 4]);
    const two = result.rows.find((r) => r.uid === 2)!;
    expect(two.rank).toBe(1);
    expect(two.baseRank).toBe(2);
    expect(two.rankDelta).toBe(1);
  });

  it("leaves everyone still when the proposed settings are the baseline", () => {
    const result = recalculate(GAMES, S2, S2);
    expect(result.rows.every((r) => r.pointsDelta === 0)).toBe(true);
    expect(result.rows.every((r) => r.rankDelta === 0)).toBe(true);
  });

  it("gives tied totals the same rank and skips the next place", () => {
    // A flat ruleset with no uma and a 25,000 return makes points the raw score
    // difference, so two players who swap 1st and 2nd end up level.
    const flat = { returnPoints: 25_000, oka: 0, uma: [0, 0, 0, 0] };
    const mirrored: RCGame[] = [
      game("m1", 100, [[1, 40_000], [2, 30_000], [3, 20_000], [4, 10_000]]),
      game("m2", 200, [[2, 40_000], [1, 30_000], [4, 20_000], [3, 10_000]]),
    ];
    const result = recalculate(mirrored, flat, flat);
    expect(result.rows.map((r) => r.rank)).toEqual([1, 1, 3, 3]);
  });

  it("keeps the most recent nickname when a player renames", () => {
    const renamed: RCGame[] = [
      game("r1", 100, [[1, 40_000], [2, 30_000], [3, 20_000], [4, 10_000]]),
      { ...game("r2", 500, [[1, 40_000], [2, 30_000], [3, 20_000], [4, 10_000]]),
        players: [
          { uid: 1, nickname: "newname", points: 40_000, rank: 1 },
          { uid: 2, nickname: "p2", points: 30_000, rank: 2 },
          { uid: 3, nickname: "p3", points: 20_000, rank: 3 },
          { uid: 4, nickname: "p4", points: 10_000, rank: 4 },
        ] },
    ];
    expect(recalculate(renamed, S1, S1).rows[0].nickname).toBe("newname");
  });

  it("handles an empty season", () => {
    const result = recalculate([], S1, S2);
    expect(result.rows).toEqual([]);
    expect(result.totalGames).toBe(0);
    expect(balanceWarning(result)).toBeUndefined();
  });
});

describe("balanceWarning", () => {
  it("stays quiet for a zero-sum ruleset", () => {
    expect(balanceWarning(recalculate(GAMES, S1, S1))).toBeUndefined();
  });

  it("flags a ruleset where the table does not balance", () => {
    // 30,000 return with no oka leaves each table 20 short.
    const warning = balanceWarning(recalculate(GAMES, S2, S2));
    expect(warning).toContain("-20.0");
    expect(warning).toContain("not zero-sum");
  });
});

describe("formatting", () => {
  it("describes settings compactly", () => {
    expect(describeSettings(S1)).toBe("uma 30/10/-10/-30 · oka 20 · return 30,000");
  });

  it("marks movement in the standings table", () => {
    const rendered = whatIfTable(recalculate(GAMES, S1, S2));
    expect(rendered).toContain("↑1");
    expect(rendered).toContain("↓1");
    expect(rendered.split("\n")[0]).toContain("Was");
  });

  it("compares settings by value", () => {
    expect(sameSettings(S1, { ...S1, uma: [...S1.uma] })).toBe(true);
    expect(sameSettings(S1, S2)).toBe(false);
    expect(sameSettings(S1, { ...S1, oka: 0 })).toBe(false);
  });
});

// The strongest check available: replaying the archived season under the
// settings it was actually played with must reproduce the tournament's own
// final standings, which is what makes a what-if under *other* settings
// trustworthy.
describe("Spring League 2026 archive", () => {
  const path = resolve(import.meta.dir, "../data/archive/s01-spring-league-2026.json");

  it("reproduces the official standings when replayed under its own settings", async () => {
    const archive = await loadArchive(path);
    const result = recalculate(archive.games, S1, S1);
    const byUid = new Map(result.rows.map((r) => [r.uid, r]));

    // Four players have one more game in the archive than the tournament
    // counted; only compare the ones whose counts agree. (Same caveat as
    // scoring.test.ts, which documents it.)
    const comparable = archive.finalLeaderboard.filter(
      (e) => byUid.get(e.userID)?.gamesPlayed === e.gamesPlayed
    );
    expect(comparable.length).toBe(10);

    for (const entry of comparable) {
      expect(byUid.get(entry.userID)!.points).toBeCloseTo(entry.rankScore / 10, 1);
      expect(byUid.get(entry.userID)!.rank).toBe(entry.rank);
    }
  });

  it("changes the standings when the uma changes", async () => {
    const archive = await loadArchive(path);
    const result = recalculate(archive.games, { ...S1, uma: [60, 20, -20, -60] }, S1);
    expect(result.rows.some((r) => r.rankDelta !== 0)).toBe(true);
    // Total points across the league stay balanced under a zero-sum ruleset.
    const total = result.rows.reduce((s, r) => s + r.points, 0);
    expect(total).toBeCloseTo(0, 0);
  });
});
