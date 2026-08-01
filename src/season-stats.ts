// Print season stats from an archive on disk — no network, no Discord.
//
// Run with: bun run stats                  (most recent archive)
//           bun run stats -- s01-spring-league-2026.json
//           bun run stats -- --player Mookjong

import { listArchives, loadArchive } from "./archive.ts";
import { summarize, formatSummaryText, pct, signed } from "./stats.ts";

const args = process.argv.slice(2);
const playerFlag = args.indexOf("--player");
const playerName = playerFlag >= 0 ? args[playerFlag + 1] : undefined;
const fileArg = args.find((a) => a.endsWith(".json"));

const archives = await listArchives();
if (archives.length === 0) {
  console.error("No archives found. Run `bun run archive` first.");
  process.exit(1);
}

const path = fileArg
  ? archives.find((p) => p.endsWith(fileArg))
  : archives[archives.length - 1];

if (!path) {
  console.error(`No archive matching "${fileArg}". Available:\n` +
    archives.map((a) => "  " + a.split("/").pop()).join("\n"));
  process.exit(1);
}

const summary = summarize(await loadArchive(path));

if (!playerName) {
  console.log(formatSummaryText(summary));
} else {
  const p = summary.players.find(
    (x) => x.nickname.toLowerCase() === playerName.toLowerCase()
  );
  if (!p) {
    console.error(`No player "${playerName}" in ${summary.seasonLabel}. Players: ` +
      summary.players.map((x) => x.nickname).join(", "));
    process.exit(1);
  }
  console.log(`=== ${p.nickname} — ${summary.seasonLabel} ===`);
  console.log(`Standing:        ${p.leaderboardRank ?? "—"}` +
    (p.rankScore != null ? `  (${signed(p.rankScore)} pts)` : ""));
  console.log(`Games played:    ${p.gamesPlayed}`);
  console.log(`Avg placement:   ${p.avgPlacement.toFixed(3)}`);
  console.log(`Placements:      1st ${p.placements[0]} · 2nd ${p.placements[1]} · ` +
    `3rd ${p.placements[2]} · 4th ${p.placements[3]}`);
  console.log(`Win rate:        ${pct(p.firstRate)}`);
  console.log(`Top-2 rate:      ${pct(p.rentaiRate)}`);
  console.log(`Last-place rate: ${pct(p.lastRate)}`);
  console.log(`Bust rate:       ${pct(p.bustRate)}`);
  console.log(`Avg end score:   ${signed(Math.round(p.avgPoints))}`);
  console.log(`Best game:       ${signed(p.bestGame.points)}  (${p.bestGame.paiPuId})`);
  console.log(`Worst game:      ${signed(p.worstGame.points)}  (${p.worstGame.paiPuId})`);
}
