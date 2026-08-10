import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import {
  gamePoints,
  formatGamePoints,
  SPRING_2026_SETTINGS as S1,
  SEASON_2_SETTINGS as S2,
  SETTINGS,
} from "./scoring.ts";
import { loadArchive } from "./archive.ts";

describe("gamePoints", () => {
  it("applies uma and oka to first place", () => {
    // 83,300 → (83300-30000)/1000 + 30 uma + 20 oka
    expect(gamePoints(83_300, 1, S1)).toBe(103.3);
  });

  it("applies uma without oka to the other placements", () => {
    expect(gamePoints(25_800, 2, S1)).toBe(5.8);
    expect(gamePoints(8_600, 3, S1)).toBe(-31.4);
    expect(gamePoints(-17_700, 4, S1)).toBe(-77.7);
  });

  it("is zero-sum across a full table", () => {
    const table: [number, number][] = [[83_300, 1], [25_800, 2], [8_600, 3], [-17_700, 4]];
    expect(table.reduce((s, [p, r]) => s + gamePoints(p, r, S1), 0)).toBeCloseTo(0, 6);
  });

  it("respects overridden settings", () => {
    const flat = { returnPoints: 25_000, oka: 0, uma: [0, 0, 0, 0] };
    expect(gamePoints(40_000, 1, flat)).toBe(15);
  });

  it("defaults to the current season's settings when nothing is configured", () => {
    // Guards against an accidental change to the shipped defaults.
    expect(SETTINGS).toEqual(S2);
  });
});

// The real figures from the first Season 2 game, when the tournament had
// exactly one game scored so each player's cumulative standing equalled that
// single game's points. It was played while a 20-point oka was still going to
// first place — that is what these numbers show, and it pins the uma at
// 15/5/-5/-15, which is the part that carries over.
//
// The league has since dropped the oka (see SEASON_2_SETTINGS), so this block
// records what the tournament did at the time; the block below it covers the
// settings in force now.
const FIRST_SEASON_2_GAME: { score: number; rank: number; points: number }[] = [
  { score: 44_700, rank: 1, points: 49.7 },
  { score: 27_600, rank: 2, points: 2.6 },
  { score: 14_000, rank: 3, points: -21.0 },
  { score: 13_700, rank: 4, points: -31.3 },
];

describe("first Season 2 game, as the tournament scored it", () => {
  const withOka = { ...S2, oka: 20 };

  it("reproduces every player's score under the oka it was played with", () => {
    for (const { score, rank, points } of FIRST_SEASON_2_GAME) {
      expect(gamePoints(score, rank, withOka)).toBeCloseTo(points, 1);
    }
  });

  it("is zero-sum with that oka", () => {
    const sum = FIRST_SEASON_2_GAME.reduce((s, t) => s + gamePoints(t.score, t.rank, withOka), 0);
    expect(sum).toBeCloseTo(0, 6);
  });
});

// Season 2 halved the uma to 15/5/-5/-15 and pays first place no oka. The
// 30,000 return still collects 5,000 from each player, so with nothing handing
// that back to the winner a table no longer balances — this is a deliberate
// league choice, and these tests pin its consequences so neither shows up as a
// surprise later.
describe("Season 2 settings, as they stand now", () => {
  it("gives first place the uma and nothing else", () => {
    // Same winning score as the game above: 20 lower without the oka.
    expect(gamePoints(44_700, 1, S2)).toBeCloseTo(29.7, 1);
  });

  it("scores the other placements identically to before — only 1st is affected", () => {
    for (const { score, rank, points } of FIRST_SEASON_2_GAME.slice(1)) {
      expect(gamePoints(score, rank, S2)).toBeCloseTo(points, 1);
    }
  });

  // A table 20 short means every game played moves a player's total by -5 on
  // average whatever they do, so the standings partly rank games played rather
  // than performance. `/season whatif` warns about this for any ruleset that
  // does not balance (see whatif.ts).
  it("leaves each table 20 short of zero-sum, the oka the return collects", () => {
    const sum = FIRST_SEASON_2_GAME.reduce((s, t) => s + gamePoints(t.score, t.rank, S2), 0);
    expect(sum).toBeCloseTo(-20, 6);
  });
});

describe("formatGamePoints", () => {
  it("signs positive values and keeps one decimal", () => {
    expect(formatGamePoints(103.3)).toBe("+103.3");
    expect(formatGamePoints(5.8)).toBe("+5.8");
  });

  it("renders negatives and zero without a plus", () => {
    expect(formatGamePoints(-77.7)).toBe("-77.7");
    expect(formatGamePoints(0)).toBe("0.0");
  });

  it("groups thousands", () => {
    expect(formatGamePoints(1234.5)).toBe("+1,234.5");
  });
});

// This is the check that the derived formula is actually the league's: replay
// every archived game and compare the totals to the tournament's own final
// standings. A drift in league settings surfaces here rather than as quietly
// wrong numbers in the game embeds.
describe("Spring League 2026 archive reproduction", () => {
  const path = resolve(import.meta.dir, "../data/archive/s01-spring-league-2026.json");

  it("reproduces the final standings from raw game scores", async () => {
    const archive = await loadArchive(path);

    const totals = new Map<number, number>();
    const counts = new Map<number, number>();
    for (const game of archive.games) {
      for (const p of game.players) {
        totals.set(p.uid, (totals.get(p.uid) ?? 0) + gamePoints(p.points, p.rank, S1));
        counts.set(p.uid, (counts.get(p.uid) ?? 0) + 1);
      }
    }

    // Four players have one more game in the archive than the tournament counted
    // (a single table the tournament excluded — the four deltas cancel to zero).
    // Every player whose count agrees must match to the displayed 0.1.
    const comparable = archive.finalLeaderboard.filter(
      (e) => counts.get(e.userID) === e.gamesPlayed
    );
    expect(comparable.length).toBe(10);

    for (const entry of comparable) {
      const computed = totals.get(entry.userID)!;
      expect(computed).toBeCloseTo(entry.rankScore / 10, 1);
    }
  });

  it("scores every archived game as zero-sum", async () => {
    const archive = await loadArchive(path);
    for (const game of archive.games) {
      const sum = game.players.reduce((s, p) => s + gamePoints(p.points, p.rank, S1), 0);
      expect(sum).toBeCloseTo(0, 6);
    }
  });
});
