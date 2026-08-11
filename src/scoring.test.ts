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
// single game's points.
//
// The season was set up with a 30,000 return and a 20-point oka, which is what
// these numbers show and what the tournament still scores by. The league has
// since corrected the return to 25,000 with no oka — the same thing for the
// three losing placements, and 20 lower for the winner. This block pins what
// Riichi City did; the one below it pins what the league now does. That the two
// differ is the point: Discord is the source of truth.
const AS_THE_TOURNAMENT_SCORED_IT = { returnPoints: 30_000, oka: 20, uma: [15, 5, -5, -15] };

const FIRST_SEASON_2_GAME: { score: number; rank: number; points: number }[] = [
  { score: 44_700, rank: 1, points: 49.7 },
  { score: 27_600, rank: 2, points: 2.6 },
  { score: 14_000, rank: 3, points: -21.0 },
  { score: 13_700, rank: 4, points: -31.3 },
];

describe("first Season 2 game, as the tournament scored it", () => {
  it("reproduces every player's score under the settings it was played with", () => {
    for (const { score, rank, points } of FIRST_SEASON_2_GAME) {
      expect(gamePoints(score, rank, AS_THE_TOURNAMENT_SCORED_IT)).toBeCloseTo(points, 1);
    }
  });

  it("is zero-sum, because the oka hands back what the 30,000 return collects", () => {
    const sum = FIRST_SEASON_2_GAME.reduce(
      (s, t) => s + gamePoints(t.score, t.rank, AS_THE_TOURNAMENT_SCORED_IT), 0
    );
    expect(sum).toBeCloseTo(0, 6);
  });
});

// The corrected settings: 25,000 return, no oka, uma 15/5/-5/-15. A 25,000
// return against a 25,000 start collects nothing, so there is nothing for an
// oka to hand back and the table balances on the uma alone.
describe("Season 2 settings, as the league now scores them", () => {
  it("pays first place the uma over its margin above the starting score", () => {
    expect(gamePoints(44_700, 1, S2)).toBeCloseTo(34.7, 1);
  });

  it("is zero-sum", () => {
    const sum = FIRST_SEASON_2_GAME.reduce((s, t) => s + gamePoints(t.score, t.rank, S2), 0);
    expect(sum).toBeCloseTo(0, 6);
  });

  // The whole effect of the correction, and the reason the standings could be
  // recomputed and re-posted without reordering much: it is a flat +5 a game,
  // so only players with unequal game counts move relative to each other.
  it("is worth exactly +5 a game to every player, whatever they placed", () => {
    for (const { score, rank } of FIRST_SEASON_2_GAME) {
      const before = gamePoints(score, rank, { ...S2, returnPoints: 30_000 });
      expect(gamePoints(score, rank, S2) - before).toBeCloseTo(5, 6);
    }
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
