// League scoring: converting a game's final table score into tournament points.
//
// Riichi City's game log (readPaiPuList) returns only raw end scores, not the
// points a game was worth, and the tournament's cumulative rankScore is the only
// place the scored value shows up. So points are recomputed here.
//
// The defaults below were derived from the Spring League 2026 archive and
// verified against it: they reproduce the final standings to the exact 0.1 for
// every player whose game count agrees with the tournament's own, and every
// game sums to exactly zero. See scoring.test.ts, which re-checks this against
// the committed archive so a settings drift shows up as a test failure.
//
// If the league changes its tournament settings, override these in .env rather
// than editing the file.

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

export interface ScoringSettings {
  // Score each player returns to at the end of a game; the difference from the
  // 25,000 starting score is what funds the oka.
  returnPoints: number;
  // Bonus awarded to first place, on top of uma.
  oka: number;
  // Placement bonus/penalty, 1st through 4th.
  uma: number[];
}

// Season 1 (Spring League 2026) settings. Pinned so the regression test against
// that archive keeps passing now that the live settings have changed.
export const SPRING_2026_SETTINGS: ScoringSettings = {
  returnPoints: 30_000,
  oka: 20,
  uma: [30, 10, -10, -30],
};

// Season 2 settings — the current defaults. Uma was halved to 15/5/-5/-15 and
// the oka dropped to 0.
//
// The uma is verified against the first Season 2 game. That game was played
// while first place was still being paid the 20-point oka the 30,000 return
// collects ((30000 - 25000) * 4 / 1000); dropping it is a deliberate league
// choice made after, so a table now totals -20 rather than balancing, and every
// game played costs each player 5 on average whatever they do. Both facts are
// pinned in scoring.test.ts.
export const SEASON_2_SETTINGS: ScoringSettings = {
  returnPoints: 30_000,
  oka: 0,
  uma: [15, 5, -5, -15],
};

const DEFAULTS = SEASON_2_SETTINGS;

function umaEnv(): number[] {
  const raw = process.env.LEAGUE_UMA;
  if (!raw) return DEFAULTS.uma;
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`LEAGUE_UMA must be four comma-separated numbers, got "${raw}"`);
  }
  return parts;
}

export const SETTINGS: ScoringSettings = {
  returnPoints: numEnv("LEAGUE_RETURN_POINTS", DEFAULTS.returnPoints),
  oka: numEnv("LEAGUE_OKA", DEFAULTS.oka),
  uma: umaEnv(),
};

// Tournament points a player earned from one game, in the same units the Riichi
// City client displays (one decimal place). Zero-sum across a full table.
export function gamePoints(
  finalScore: number,
  rank: number,
  settings: ScoringSettings = SETTINGS,
): number {
  const uma = settings.uma[rank - 1] ?? 0;
  const oka = rank === 1 ? settings.oka : 0;
  // Rounded to one decimal to match the client and to keep binary
  // representation error out of displayed totals.
  return Math.round(((finalScore - settings.returnPoints) / 1000 + uma + oka) * 10) / 10;
}

// Signed, one-decimal rendering: "+103.3", "-52.7", "0.0".
export function formatGamePoints(points: number): string {
  const body = points.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return points > 0 ? `+${body}` : body;
}
