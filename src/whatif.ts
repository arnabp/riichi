// "What if the league had used different uma/oka?" — replays a season's games
// through an alternative ScoringSettings and re-ranks everyone.
//
// This is possible because the standings are just a sum of per-game points, and
// gamePoints() derives those from the raw table score alone (see scoring.ts).
// So any settings can be applied retroactively to the archived games.
//
// The baseline column is *also* recomputed, from the same games, rather than
// taken from the tournament's own leaderboard: the two are then apples to
// apples, every player appears in both (the leaderboard only carries ranked
// players), and a game-count disagreement between the archive and the
// tournament can't show up as a phantom swing.

import { RCGame } from "./riichicity.ts";
import { ScoringSettings, SETTINGS, gamePoints, formatGamePoints, roundPoints } from "./scoring.ts";
import { standings, table } from "./stats.ts";

export interface WhatIfRow {
  uid: number;
  nickname: string;
  gamesPlayed: number;
  points: number;      // total under the proposed settings
  rank: number;
  basePoints: number;  // total under the baseline settings
  baseRank: number;
  pointsDelta: number; // points - basePoints
  rankDelta: number;   // baseRank - rank; positive means moved up
}

export interface WhatIfResult {
  settings: ScoringSettings;
  baseline: ScoringSettings;
  totalGames: number;
  rows: WhatIfRow[]; // ordered by the proposed standings
  // What one full table sums to under the proposed settings. Zero for a
  // balanced ruleset; anything else means totals drift with games played.
  tableSum: number;
}

export function recalculate(
  games: RCGame[],
  settings: ScoringSettings,
  baseline: ScoringSettings = SETTINGS,
): WhatIfResult {
  // Both columns come from the same function the live standings do, so a
  // what-if under the current settings is exactly the current table.
  const proposed = standings(games, settings);
  const base = new Map(standings(games, baseline).map((s) => [s.uid, s]));

  const rows: WhatIfRow[] = proposed.map((s) => {
    const b = base.get(s.uid)!;
    return {
      uid: s.uid,
      nickname: s.nickname,
      gamesPlayed: s.gamesPlayed,
      points: s.points,
      rank: s.rank,
      basePoints: b.points,
      baseRank: b.rank,
      pointsDelta: roundPoints(s.points - b.points),
      rankDelta: b.rank - s.rank,
    };
  });

  return {
    settings,
    baseline,
    totalGames: games.length,
    rows,
    tableSum: games.length ? roundPoints(tableSumOf(games[0], settings)) : 0,
  };
}

function tableSumOf(game: RCGame, settings: ScoringSettings): number {
  return game.players.reduce((s, p) => s + gamePoints(p.points, p.rank, settings), 0);
}

// ── Settings input ────────────────────────────────────────────────────────────

// Accepts "30,10,-10,-30" (any of comma / slash / whitespace as the separator),
// or the two-number shorthand "30,10" the rules are usually quoted as, which
// mirrors into 30/10/-10/-30.
export function parseUma(raw: string): number[] {
  const parts = raw.trim().split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Uma must be numbers, got "${raw}"`);
  }
  if (parts.length === 2) return [parts[0], parts[1], -parts[1], -parts[0]];
  if (parts.length === 4) return parts;
  throw new Error(
    `Uma must be four values ("30,10,-10,-30") or the two-value shorthand ("30,10"), got "${raw}"`
  );
}

export function describeSettings(s: ScoringSettings): string {
  return `uma ${s.uma.join("/")} · oka ${s.oka} · return ${s.returnPoints.toLocaleString("en-US")}`;
}

export function sameSettings(a: ScoringSettings, b: ScoringSettings): boolean {
  return a.oka === b.oka
    && a.returnPoints === b.returnPoints
    && a.uma.length === b.uma.length
    && a.uma.every((n, i) => n === b.uma[i]);
}

// ── Formatting ────────────────────────────────────────────────────────────────

// Narrow enough for a Discord embed code block (~55 monospace chars before it
// wraps). "Was" is the player's place under the current settings, so movement
// reads off the two rank columns.
export function whatIfTable(result: WhatIfResult): string {
  const head = ["#", "Player", "Pts", "Was", "ΔPts"];
  const rows = result.rows.map((r) => [
    String(r.rank),
    r.nickname,
    formatGamePoints(r.points),
    `${r.baseRank}${movement(r.rankDelta)}`,
    formatGamePoints(r.pointsDelta),
  ]);
  return table([head, ...rows]);
}

function movement(rankDelta: number): string {
  if (rankDelta > 0) return ` ↑${rankDelta}`;
  if (rankDelta < 0) return ` ↓${-rankDelta}`;
  return "";
}

// Called out because it is the trap in oka/uma experiments: if a table doesn't
// sum to zero, every game played moves a player's total by a fixed amount, so
// the standings partly rank games played rather than performance.
export function balanceWarning(result: WhatIfResult): string | undefined {
  if (Math.abs(result.tableSum) < 0.05) return undefined;
  const per = formatGamePoints(result.tableSum);
  const each = formatGamePoints(Math.round((result.tableSum / 4) * 10) / 10);
  const direction = result.tableSum < 0 ? "down" : "up";
  return (
    `⚠️ These settings are not zero-sum: each table totals ${per} instead of 0, ` +
    `so every game played moves a player's total by ${each} on average no matter how they do. ` +
    `Players with more games are pushed ${direction} the table.`
  );
}

export function formatWhatIfText(result: WhatIfResult, label: string): string {
  const lines = [
    `=== ${label} — what if: ${describeSettings(result.settings)} ===`,
    `${result.totalGames} games · baseline: ${describeSettings(result.baseline)}`,
    "",
    whatIfTable(result),
  ];
  const warning = balanceWarning(result);
  if (warning) lines.push("", warning.replace(/^⚠️ /, "WARNING: "));
  return lines.join("\n");
}
