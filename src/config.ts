import { TournamentConfig } from "./tracker.ts";

export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

// Each tournament is defined by a block of env vars:
//   TOURNAMENT_1_ID, TOURNAMENT_1_CHANNEL, TOURNAMENT_1_LABEL
//   TOURNAMENT_1_STATUS_CHANNEL  (optional — enables the status channel feature)
//   ... and so on for TOURNAMENT_2_*, etc.
//
// Env is the baseline; a season rollover can override the id/label at runtime
// (see season.ts), so callers inside the bot should prefer the live config.
export function loadTournaments(): TournamentConfig[] {
  const configs: TournamentConfig[] = [];
  for (let i = 1; ; i++) {
    const id = process.env[`TOURNAMENT_${i}_ID`];
    if (!id) break;
    configs.push({
      tournamentId: id,
      discordChannelId: requireEnv(`TOURNAMENT_${i}_CHANNEL`),
      statusChannelId: process.env[`TOURNAMENT_${i}_STATUS_CHANNEL`],
      label: process.env[`TOURNAMENT_${i}_LABEL`] ?? `Tournament ${i}`,
    });
  }
  if (configs.length === 0) {
    throw new Error(
      "No tournaments configured. Set TOURNAMENT_1_ID, TOURNAMENT_1_CHANNEL, TOURNAMENT_1_LABEL in .env"
    );
  }
  return configs;
}

// Discord user IDs allowed to run season admin commands (comma-separated).
export function loadAdminIds(): Set<string> {
  const raw = process.env.DISCORD_ADMIN_IDS ?? "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

// Guild the slash commands get registered to.
export function guildId(): string | undefined {
  return process.env.DISCORD_GUILD_ID;
}
