import { resolve } from "node:path";
import { mkdir, rename, readdir } from "node:fs/promises";
import {
  RCGame,
  RCLeaderboardEntry,
  RiichiCityClient,
} from "./riichicity.ts";
// Type-only: tracker.ts imports fetchAllGames from here, and `import type` is
// erased, so the two modules never form a cycle at runtime.
import type { TournamentConfig } from "./tracker.ts";
import { ScoringSettings, SETTINGS } from "./scoring.ts";

export const ARCHIVE_DIR = process.env.ARCHIVE_DIR ?? resolve("data/archive");

const PAGE_SIZE = 20;
const MAX_PAGES = 500; // safety stop; 500 pages = 10k games

// A frozen record of one finished season. Everything needed to recompute stats
// offline, so it survives the tournament being reset on Riichi City's side.
export interface SeasonArchive {
  seasonLabel: string;
  seasonNumber: number;
  tournamentId: string;
  classifyId: string;
  matchId: number;
  archivedAt: string; // ISO timestamp
  // The league settings the season was played under. Standings are recomputed
  // from raw scores, so without this a finished season would be re-scored under
  // whatever the rules happen to be later — Spring League 2026 was played with
  // 30/10/-10/-30 and an oka, and has to keep being reported that way.
  // Optional only because archives written before this field existed lack it;
  // those fall back to the current settings.
  settings?: ScoringSettings;
  games: RCGame[];    // oldest first
  // The tournament's own scoring at archive time. Preserved verbatim: it is
  // scored under Riichi City's settings, which the league's need not match.
  finalLeaderboard: RCLeaderboardEntry[];
}

// Pull every completed game for a tournament, oldest first.
export async function fetchAllGames(
  client: RiichiCityClient,
  classifyId: string,
  onProgress?: (fetched: number) => void,
): Promise<RCGame[]> {
  const byId = new Map<string, RCGame>();

  for (let page = 0; page < MAX_PAGES; page++) {
    const skip = page * PAGE_SIZE;
    const { games, rawCount } = await client.getCompletedGamesPage(
      classifyId, skip, PAGE_SIZE
    );
    for (const g of games) byId.set(g.paiPuId, g);
    onProgress?.(byId.size);
    // Stop only when the server has nothing left — a page of all-abandoned
    // games yields zero usable games but is not the end of history.
    if (rawCount === 0) break;
  }

  return [...byId.values()].sort((a, b) => a.endTime - b.endTime);
}

export async function buildArchive(
  client: RiichiCityClient,
  config: TournamentConfig,
  seasonNumber = 1,
  onProgress?: (fetched: number) => void,
): Promise<SeasonArchive> {
  const info = await client.enterTournament(config.tournamentId);
  const games = await fetchAllGames(client, info.classifyId, onProgress);
  const finalLeaderboard = await client.getLeaderboard(info.classifyId, info.matchId);

  return {
    seasonLabel: config.label,
    seasonNumber,
    tournamentId: config.tournamentId,
    classifyId: info.classifyId,
    matchId: info.matchId,
    archivedAt: new Date().toISOString(),
    settings: SETTINGS,
    games,
    finalLeaderboard,
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

// Seasons reuse one tournament id, so the season number — not the tournament —
// is what keeps successive archives from overwriting each other.
export function archiveFilename(archive: SeasonArchive): string {
  const slug = archive.seasonLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "season";
  const seq = String(archive.seasonNumber).padStart(2, "0");
  return `s${seq}-${slug}.json`;
}

export async function saveArchive(archive: SeasonArchive, dir = ARCHIVE_DIR): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, archiveFilename(archive));
  const tmp = path + ".tmp";
  await Bun.write(tmp, JSON.stringify(archive, null, 2));
  await rename(tmp, path);
  return path;
}

export async function loadArchive(path: string): Promise<SeasonArchive> {
  return JSON.parse(await Bun.file(path).text()) as SeasonArchive;
}

export async function listArchives(dir = ARCHIVE_DIR): Promise<string[]> {
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith(".json")).sort().map((f) => resolve(dir, f));
  } catch {
    return [];
  }
}
