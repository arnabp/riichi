import { resolve } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import { TournamentConfig } from "./tracker.ts";

const SEASON_FILE = process.env.SEASON_FILE ?? resolve("data/season_state.json");

// The league reuses one Riichi City tournament across seasons — the tournament
// gets reset in place rather than recreated. So the season identity (number and
// label) lives here rather than being derivable from the tournament id.
export interface SeasonRecord {
  seasonNumber: number;
  label: string;
  startedAt: string;          // ISO
  endedAt?: string;           // ISO, set at rollover
  archivePath?: string;       // set once the season has been archived
}

interface TournamentSeasons {
  current: SeasonRecord;
  past: SeasonRecord[]; // oldest first
}

interface SeasonState {
  [tournamentId: string]: TournamentSeasons;
}

export class SeasonStore {
  private state: SeasonState = {};

  constructor(private path: string = SEASON_FILE) {}

  async load(): Promise<void> {
    try {
      this.state = JSON.parse(await Bun.file(this.path).text());
    } catch {
      this.state = {};
    }
  }

  // The season in progress for a tournament. Seeded from the env label the
  // first time we see the tournament, so existing deployments need no migration.
  current(config: TournamentConfig): SeasonRecord {
    return this.state[config.tournamentId]?.current ?? {
      seasonNumber: 1,
      label: config.label,
      startedAt: new Date().toISOString(),
    };
  }

  // Every season already closed out on this tournament, oldest first.
  past(config: TournamentConfig): SeasonRecord[] {
    return this.state[config.tournamentId]?.past ?? [];
  }

  // Config with the live season label applied, for use in embeds and archives.
  resolve(config: TournamentConfig): TournamentConfig {
    return { ...config, label: this.current(config).label };
  }

  async update(tournamentId: string, patch: Partial<SeasonRecord>): Promise<SeasonRecord> {
    const entry = this.state[tournamentId];
    if (!entry) throw new Error(`No season record for tournament ${tournamentId}`);
    entry.current = { ...entry.current, ...patch };
    await this.save();
    return entry.current;
  }

  // Persist the seeded record so `update` has something to patch.
  async ensure(config: TournamentConfig): Promise<SeasonRecord> {
    if (!this.state[config.tournamentId]) {
      this.state[config.tournamentId] = { current: this.current(config), past: [] };
      await this.save();
    }
    return this.state[config.tournamentId].current;
  }

  // Close out the current season and open the next one. The closed season moves
  // into `past` rather than being overwritten — it holds the pointer to that
  // season's archive, which is the only remaining record once the tournament resets.
  async rollover(
    config: TournamentConfig,
    newLabel: string,
    archivePath: string,
  ): Promise<SeasonRecord> {
    await this.ensure(config);
    const entry = this.state[config.tournamentId];

    const closed: SeasonRecord = {
      ...entry.current,
      endedAt: new Date().toISOString(),
      archivePath,
    };
    entry.past.push(closed);
    entry.current = {
      seasonNumber: closed.seasonNumber + 1,
      label: newLabel,
      startedAt: new Date().toISOString(),
    };
    await this.save();
    return entry.current;
  }

  private async save(): Promise<void> {
    await mkdir(resolve(this.path, ".."), { recursive: true });
    const tmp = this.path + ".tmp";
    await Bun.write(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.path);
  }
}
