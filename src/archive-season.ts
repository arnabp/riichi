// Snapshot every configured tournament's full game history to data/archive/.
// Read-only against Riichi City; safe to run repeatedly (re-running overwrites
// that season's file with a fresh pull).
//
// Run with: bun run archive
//   or a single tournament: bun run archive -- 1

import { RiichiCityClient } from "./riichicity.ts";
import { buildArchive, saveArchive } from "./archive.ts";
import { loadTournaments, requireEnv } from "./config.ts";
import { SeasonStore } from "./season.ts";
import { summarize, formatSummaryText } from "./stats.ts";

const only = process.argv[2]; // optional 1-based tournament index

const client = new RiichiCityClient(
  requireEnv("RIICHI_EMAIL"),
  requireEnv("RIICHI_PASSWORD"),
  process.env.RIICHI_PASSWORD_IS_MD5 === "true",
  requireEnv("RIICHI_EMAIL_SUFFIX"),
  requireEnv("RIICHI_DEVICE_ID"),
);

await client.login();

const tournaments = loadTournaments();
const selected = only
  ? [tournaments[Number(only) - 1]].filter(Boolean)
  : tournaments;

if (selected.length === 0) {
  console.error(`No tournament at index ${only} (have ${tournaments.length})`);
  process.exit(1);
}

const seasons = new SeasonStore();
await seasons.load();

for (const config of selected) {
  const season = await seasons.ensure(config);
  console.log(
    `\n[Archive] "${season.label}" — season ${season.seasonNumber} ` +
    `(tournament ${config.tournamentId})`
  );
  const archive = await buildArchive(
    client,
    { ...config, label: season.label },
    season.seasonNumber,
    (n) => process.stdout.write(`\r[Archive]   fetched ${n} games...`),
  );
  process.stdout.write("\n");

  const path = await saveArchive(archive);
  await seasons.update(config.tournamentId, { archivePath: path });
  console.log(`[Archive] Saved ${archive.games.length} games → ${path}`);

  const summary = summarize(archive);
  console.log("\n" + formatSummaryText(summary));
}
