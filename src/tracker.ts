import { resolve } from "node:path";
import { rename } from "node:fs/promises";
import {
  RCGame,
  RCLeaderboardEntry,
  RCTournamentInfo,
  RiichiCityClient,
  SessionExpiredError,
} from "./riichicity.ts";

const STATE_FILE = process.env.STATE_FILE ?? resolve("seen_games.json");
const STATUS_FILE = process.env.STATUS_FILE ?? resolve("status_state.json");
const MAX_SEEN_IDS = 5000;

export interface TournamentConfig {
  tournamentId: string;      // external ID from Riichi City UI
  discordChannelId: string;  // games channel
  statusChannelId?: string;  // optional status channel (leaderboard + queue)
  label: string;
}

export interface TournamentStatus {
  info: RCTournamentInfo;
  leaderboard: RCLeaderboardEntry[];
}

// Per-tournament state persisted to status_state.json
interface TournamentStatusState {
  leaderboardMessageId?: string;
  queueMessageId?: string;
}

interface StatusState {
  [tournamentId: string]: TournamentStatusState;
}

export class GameTracker {
  private tournamentInfo = new Map<string, RCTournamentInfo>(); // tournamentId → info
  private seenIds = new Set<string>();
  private statusState: StatusState = {};

  constructor(
    private client: RiichiCityClient,
    private tournaments: TournamentConfig[]
  ) {}

  async init(): Promise<void> {
    await this.loadState();
    await this.loadStatusState();
    for (const t of this.tournaments) {
      const info = await this.client.enterTournament(t.tournamentId);
      this.tournamentInfo.set(t.tournamentId, info);
      console.log(`[Tracker] "${t.label}" → classifyId=${info.classifyId} matchId=${info.matchId}`);
    }
  }

  // Returns new completed games grouped by tournament config
  async poll(): Promise<{ config: TournamentConfig; game: RCGame }[]> {
    const results: { config: TournamentConfig; game: RCGame }[] = [];

    for (const config of this.tournaments) {
      const info = this.tournamentInfo.get(config.tournamentId);
      if (!info) throw new Error(`No tournament info for "${config.tournamentId}" — was init() called?`);

      const games = await this.client.getCompletedGames(info.classifyId);
      for (const game of games) {
        if (!this.seenIds.has(game.paiPuId)) {
          this.seenIds.add(game.paiPuId);
          results.push({ config, game });
        }
      }
    }

    if (results.length > 0) {
      this.trimSeenIds();
      await this.saveState();
    }
    return results;
  }

  // Returns current status for tournaments that have a statusChannelId
  async pollStatus(): Promise<{ config: TournamentConfig; status: TournamentStatus }[]> {
    const results: { config: TournamentConfig; status: TournamentStatus }[] = [];

    for (const config of this.tournaments) {
      if (!config.statusChannelId) continue;

      const info = await this.client.enterTournament(config.tournamentId);
      this.tournamentInfo.set(config.tournamentId, info);

      const leaderboard = await this.client.getLeaderboard(info.classifyId, info.matchId);
      results.push({ config, status: { info, leaderboard } });
    }

    return results;
  }

  // ── Season rollover ─────────────────────────────────────────────────────────

  // Start a new season. seenIds is seeded with the outgoing season's game IDs
  // rather than emptied: if the tournament has not actually been reset on Riichi
  // City's side yet, an empty set would make the bot re-post the entire previous
  // season into the freshly cleared channel. New games get new IDs either way.
  async resetSeason(tournamentId: string, archivedGameIds: string[]): Promise<void> {
    this.seenIds = new Set(archivedGameIds);
    delete this.statusState[tournamentId];
    await this.saveState();
    await this.saveStatusState();
    console.log(
      `[Tracker] Season reset for ${tournamentId} — seeded ${archivedGameIds.length} archived game IDs`
    );
  }

  // Refresh cached tournament info after a reset (classifyId can change).
  async refreshTournament(tournamentId: string): Promise<RCTournamentInfo> {
    const info = await this.client.enterTournament(tournamentId);
    this.tournamentInfo.set(tournamentId, info);
    return info;
  }

  // ── Status message ID persistence ───────────────────────────────────────────

  getStatusMessageIds(tournamentId: string): TournamentStatusState {
    return this.statusState[tournamentId] ?? {};
  }

  async setLeaderboardMessageId(tournamentId: string, id: string): Promise<void> {
    this.statusState[tournamentId] ??= {};
    this.statusState[tournamentId].leaderboardMessageId = id;
    await this.saveStatusState();
  }

  async setQueueMessageId(tournamentId: string, id: string | undefined): Promise<void> {
    this.statusState[tournamentId] ??= {};
    this.statusState[tournamentId].queueMessageId = id;
    await this.saveStatusState();
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  private trimSeenIds(): void {
    if (this.seenIds.size > MAX_SEEN_IDS) {
      const entries = [...this.seenIds];
      this.seenIds = new Set(entries.slice(Math.floor(entries.length / 2)));
    }
  }

  private async loadState(): Promise<void> {
    try {
      const raw = await Bun.file(STATE_FILE).text();
      const ids: string[] = JSON.parse(raw);
      this.seenIds = new Set(ids);
      console.log(`[Tracker] Loaded ${this.seenIds.size} seen game IDs from ${STATE_FILE}`);
    } catch {
      console.log("[Tracker] No state file found, starting fresh");
    }
  }

  private async saveState(): Promise<void> {
    const tmp = STATE_FILE + ".tmp";
    await Bun.write(tmp, JSON.stringify([...this.seenIds]));
    await rename(tmp, STATE_FILE);
  }

  private async loadStatusState(): Promise<void> {
    try {
      const raw = await Bun.file(STATUS_FILE).text();
      this.statusState = JSON.parse(raw);
      console.log(`[Tracker] Loaded status state from ${STATUS_FILE}`);
    } catch {
      this.statusState = {};
    }
  }

  private async saveStatusState(): Promise<void> {
    const tmp = STATUS_FILE + ".tmp";
    await Bun.write(tmp, JSON.stringify(this.statusState, null, 2));
    await rename(tmp, STATUS_FILE);
  }
}

// Wrap a poll with automatic session re-login on expiry
export async function withSessionRetry(
  client: RiichiCityClient,
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      console.log("[Tracker] Session expired, re-logging in...");
      await client.login();
      await fn(); // one retry after fresh login
    } else {
      throw err;
    }
  }
}
