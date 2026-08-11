import { RCGame } from "./riichicity.ts";
// Type-only: archive.ts imports TournamentConfig from tracker.ts, and tracker.ts
// imports standings() from here. `import type` is erased, so the cycle never
// exists at runtime.
import type { SeasonArchive } from "./archive.ts";
import {
  ScoringSettings,
  SETTINGS,
  gamePoints,
  formatGamePoints,
  roundPoints,
} from "./scoring.ts";

export interface GameRef {
  paiPuId: string;
  endTime: number;
  points: number;
  nickname: string;
}

// A league standing computed here, from raw table scores, rather than read from
// the tournament's own rankScore. This is what Discord posts: the league's
// uma/oka is not what Riichi City applies (see scoring.ts), and only this side
// can be recomputed when the settings are corrected.
export interface Standing {
  uid: number;
  nickname: string;  // most recent nickname seen for this uid
  gamesPlayed: number;
  points: number;    // cumulative league points, one decimal
  rank: number;      // 1-indexed; equal totals share a rank
}

// The single place a set of games becomes a league table. Used for the live
// standings message, the season summary, and `/season whatif`.
export function standings(games: RCGame[], settings: ScoringSettings = SETTINGS): Standing[] {
  interface Acc {
    uid: number;
    nickname: string;
    lastSeen: number;
    gamesPlayed: number;
    points: number;
  }
  const accs = new Map<number, Acc>();

  for (const game of games) {
    for (const p of game.players) {
      let acc = accs.get(p.uid);
      if (!acc) {
        acc = { uid: p.uid, nickname: p.nickname, lastSeen: -1, gamesPlayed: 0, points: 0 };
        accs.set(p.uid, acc);
      }
      // Nicknames change mid-season; keep the one from the most recent game.
      if (game.endTime >= acc.lastSeen) {
        acc.nickname = p.nickname;
        acc.lastSeen = game.endTime;
      }
      acc.gamesPlayed++;
      acc.points += gamePoints(p.points, p.rank, settings);
    }
  }

  // Sort is stable, so players level on points stay in the order they first
  // appeared rather than shuffling between polls.
  const sorted = [...accs.values()]
    .map((a) => ({ uid: a.uid, nickname: a.nickname, gamesPlayed: a.gamesPlayed, points: roundPoints(a.points) }))
    .sort((a, b) => b.points - a.points);

  // Standard competition ranking: equal totals share a rank, and the next player
  // down skips the tied places.
  const ranked: Standing[] = [];
  sorted.forEach((s, i) => {
    const prev = sorted[i - 1];
    ranked.push({ ...s, rank: prev && prev.points === s.points ? ranked[i - 1].rank : i + 1 });
  });
  return ranked;
}

export interface PlayerStats {
  uid: number;
  nickname: string;      // most recent nickname seen for this uid
  gamesPlayed: number;
  placements: number[];  // [#1st, #2nd, #3rd, #4th]
  avgPlacement: number;
  firstRate: number;     // share of games won outright
  rentaiRate: number;    // share finishing top-2
  lastRate: number;      // share finishing last
  bustRate: number;      // share ending below zero
  totalPoints: number;
  avgPoints: number;
  bestGame: GameRef;
  worstGame: GameRef;
  // The league standing, computed from the games by standings(). This is the
  // official number.
  leaguePoints: number;
  rank: number;
  // What the tournament's own leaderboard said at archive time, when the player
  // appeared on it. Kept for reference only — it is scored under Riichi City's
  // settings, which the league's no longer match (see scoring.ts).
  rankScore?: number;
  leaderboardRank?: number;
}

export interface SeasonSummary {
  seasonLabel: string;
  tournamentId: string;
  archivedAt: string;
  totalGames: number;
  firstGameAt?: number;
  lastGameAt?: number;
  players: PlayerStats[]; // official leaderboard order where known
  highestScore?: GameRef;
  lowestScore?: GameRef;
}

interface Acc {
  uid: number;
  nickname: string;
  lastSeen: number;
  placements: number[];
  totalPoints: number;
  games: GameRef[];
}

export function summarize(archive: SeasonArchive): SeasonSummary {
  const accs = new Map<number, Acc>();

  for (const game of archive.games) {
    for (const p of game.players) {
      let acc = accs.get(p.uid);
      if (!acc) {
        acc = { uid: p.uid, nickname: p.nickname, lastSeen: -1, placements: [], totalPoints: 0, games: [] };
        accs.set(p.uid, acc);
      }
      // Nicknames change mid-season; keep the one from the most recent game.
      if (game.endTime >= acc.lastSeen) {
        acc.nickname = p.nickname;
        acc.lastSeen = game.endTime;
      }
      acc.placements[p.rank - 1] = (acc.placements[p.rank - 1] ?? 0) + 1;
      acc.totalPoints += p.points;
      acc.games.push({
        paiPuId: game.paiPuId,
        endTime: game.endTime,
        points: p.points,
        nickname: p.nickname,
      });
    }
  }

  const byUid = new Map(archive.finalLeaderboard.map((e) => [e.userID, e]));
  // The settings the season was played under, so a finished season keeps
  // reporting the standings it actually finished with.
  const table = new Map(
    standings(archive.games, archive.settings ?? SETTINGS).map((s) => [s.uid, s])
  );

  const players: PlayerStats[] = [...accs.values()].map((acc) => {
    const gamesPlayed = acc.games.length;
    const placements = fill(acc.placements, 4);
    const placementSum = placements.reduce((s, n, i) => s + n * (i + 1), 0);
    const sorted = [...acc.games].sort((a, b) => b.points - a.points);
    const lb = byUid.get(acc.uid);
    const standing = table.get(acc.uid)!;

    return {
      uid: acc.uid,
      nickname: acc.nickname,
      gamesPlayed,
      placements,
      avgPlacement: gamesPlayed ? placementSum / gamesPlayed : 0,
      firstRate: rate(placements[0], gamesPlayed),
      rentaiRate: rate(placements[0] + placements[1], gamesPlayed),
      lastRate: rate(placements[3], gamesPlayed),
      bustRate: rate(acc.games.filter((g) => g.points < 0).length, gamesPlayed),
      totalPoints: acc.totalPoints,
      avgPoints: gamesPlayed ? acc.totalPoints / gamesPlayed : 0,
      bestGame: sorted[0],
      worstGame: sorted[sorted.length - 1],
      leaguePoints: standing.points,
      rank: standing.rank,
      rankScore: lb?.rankScore,
      leaderboardRank: lb?.rank,
    };
  });

  // League standing, which every player has — unlike the tournament's own
  // leaderboard, which only carries the players it ranked.
  players.sort((a, b) => a.rank - b.rank);

  const allRefs = players.flatMap((p) => [p.bestGame, p.worstGame]).filter(Boolean);
  const times = archive.games.map((g) => g.endTime);

  return {
    seasonLabel: archive.seasonLabel,
    tournamentId: archive.tournamentId,
    archivedAt: archive.archivedAt,
    totalGames: archive.games.length,
    firstGameAt: times.length ? Math.min(...times) : undefined,
    lastGameAt: times.length ? Math.max(...times) : undefined,
    players,
    highestScore: maxBy(allRefs, (r) => r.points),
    lowestScore: minBy(allRefs, (r) => r.points),
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────

// Aligned standings table, shared by the console output and the Discord embed
// (Discord renders it inside a code block, which is also monospace).
// Kept deliberately narrow: a Discord embed has a fixed maximum width regardless
// of window size, and wraps (badly) past roughly 55 monospace characters. Games
// played is omitted because the placement counts already sum to it, and average
// placement is available per-player via `bun run stats -- --player <name>`.
export function standingsTable(s: SeasonSummary): string {
  const head = ["#", "Player", "Pts", "1/2/3/4", "AvgScore"];
  const rows = s.players.map((p) => [
    String(p.rank),
    p.nickname,
    formatGamePoints(p.leaguePoints),
    p.placements.join("/"),
    signed(Math.round(p.avgPoints)),
  ]);
  return table([head, ...rows]);
}

export function dateRange(s: SeasonSummary): string {
  return s.firstGameAt && s.lastGameAt
    ? `${dateOf(s.firstGameAt)} → ${dateOf(s.lastGameAt)}`
    : "";
}

export function formatGameRef(r: GameRef): string {
  return `${r.nickname} ${signed(r.points)} (${dateOf(r.endTime)})`;
}

export function formatSummaryText(s: SeasonSummary): string {
  const lines: string[] = [];
  lines.push(`=== ${s.seasonLabel} — Season Summary ===`);
  lines.push(`${s.totalGames} games` + (dateRange(s) ? `  |  ${dateRange(s)}` : ""));
  lines.push("");
  lines.push(standingsTable(s));

  if (s.highestScore) {
    lines.push("");
    lines.push(`Highest game: ${formatGameRef(s.highestScore)}`);
  }
  if (s.lowestScore) {
    lines.push(`Lowest game:  ${formatGameRef(s.lowestScore)}`);
  }
  return lines.join("\n");
}

// Column-aligned text table, shared with the what-if standings (whatif.ts).
export function table(rows: string[][]): string {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => visualWidth(r[c] ?? ""))));
  return rows
    .map((r) => r.map((cell, c) => pad(cell, widths[c])).join("  ").trimEnd())
    .join("\n");
}

// CJK nicknames render double-width in a terminal; count them as 2 so columns line up.
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visualWidth(s)));
}

export function signed(n: number): string {
  return (n > 0 ? "+" : "") + n.toLocaleString("en-US");
}

// The API reports tournament rank score as a fixed-point integer with one
// implied decimal place: the game client shows a stored 12600 as "1260.0".
// Archives keep the raw value as the API returned it, so every user-facing
// render goes through here to stay consistent with the Riichi City client.
//
// Note this applies only to rankScore. Per-game `points` are true mahjong end
// scores and are not scaled — they sum to 100000 per game.
export const RANK_SCORE_SCALE = 10;

export function formatRankScore(raw: number): string {
  return (raw / RANK_SCORE_SCALE).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

export function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// Local date, not UTC — league games run in the evening, and UTC would report
// most of them as having happened the following day.
function dateOf(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fill(arr: number[], n: number): number[] {
  return Array.from({ length: n }, (_, i) => arr[i] ?? 0);
}

function rate(count: number, total: number): number {
  return total ? count / total : 0;
}

function maxBy<T>(items: T[], key: (t: T) => number): T | undefined {
  return items.reduce<T | undefined>((best, x) => (!best || key(x) > key(best) ? x : best), undefined);
}

function minBy<T>(items: T[], key: (t: T) => number): T | undefined {
  return items.reduce<T | undefined>((best, x) => (!best || key(x) < key(best) ? x : best), undefined);
}
