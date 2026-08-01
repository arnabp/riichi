import { RCGame } from "./riichicity.ts";
import { SeasonArchive } from "./archive.ts";

export interface GameRef {
  paiPuId: string;
  endTime: number;
  points: number;
  nickname: string;
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
  // Carried over from the tournament's own leaderboard when available —
  // this, not our derived numbers, is the official league standing.
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

  const players: PlayerStats[] = [...accs.values()].map((acc) => {
    const gamesPlayed = acc.games.length;
    const placements = fill(acc.placements, 4);
    const placementSum = placements.reduce((s, n, i) => s + n * (i + 1), 0);
    const sorted = [...acc.games].sort((a, b) => b.points - a.points);
    const lb = byUid.get(acc.uid);

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
      rankScore: lb?.rankScore,
      leaderboardRank: lb?.rank,
    };
  });

  // Official standing first; players missing from the leaderboard fall to the
  // bottom, ordered by average placement.
  players.sort((a, b) => {
    if (a.leaderboardRank != null && b.leaderboardRank != null) {
      return a.leaderboardRank - b.leaderboardRank;
    }
    if (a.leaderboardRank != null) return -1;
    if (b.leaderboardRank != null) return 1;
    return a.avgPlacement - b.avgPlacement;
  });

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
export function standingsTable(s: SeasonSummary): string {
  const head = ["#", "Player", "Pts", "G", "Avg", "1st", "2nd", "3rd", "4th", "Avg±"];
  const rows = s.players.map((p, i) => [
    String(p.leaderboardRank ?? i + 1),
    p.nickname,
    p.rankScore != null ? p.rankScore.toLocaleString("en-US") : "—",
    String(p.gamesPlayed),
    p.avgPlacement.toFixed(2),
    String(p.placements[0]),
    String(p.placements[1]),
    String(p.placements[2]),
    String(p.placements[3]),
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

function table(rows: string[][]): string {
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
