// Print season stats from an archive on disk — no network, no Discord.
//
// Run with: bun run stats                  (most recent archive)
//           bun run stats -- s01-spring-league-2026.json
//           bun run stats -- --player Mookjong
//           bun run stats -- --uma 30,10,-10,-30 --oka 20   (re-score, see whatif.ts)

import { listArchives, loadArchive } from "./archive.ts";
import { summarize, formatSummaryText, pct, signed, formatRankScore } from "./stats.ts";
import { SETTINGS, formatGamePoints } from "./scoring.ts";
import { recalculate, parseUma, formatWhatIfText } from "./whatif.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const playerName = flag("--player");
const umaArg = flag("--uma");
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

const archive = await loadArchive(path);

if (umaArg) {
  const num = (name: string, fallback: number) => {
    const raw = flag(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      console.error(`${name} must be a number, got "${raw}"`);
      process.exit(1);
    }
    return n;
  };
  // Defaults and the comparison column come from the settings the archived
  // season was played under, which for a past season is not today's.
  const base = archive.settings ?? SETTINGS;
  let settings;
  try {
    settings = {
      returnPoints: num("--return", base.returnPoints),
      oka: num("--oka", base.oka),
      uma: parseUma(umaArg),
    };
  } catch (err) {
    // A malformed --uma is a typo, not a bug; a stack trace would only bury it.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const result = recalculate(archive.games, settings, base);
  console.log(formatWhatIfText(result, archive.seasonLabel));
  process.exit(0);
}

const summary = summarize(archive);

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
  console.log(`Standing:        ${p.rank}  (${formatGamePoints(p.leaguePoints)} pts)`);
  if (p.rankScore != null) {
    // Riichi City scores the tournament under its own settings, which the
    // league's no longer match; shown so a discrepancy can be traced.
    console.log(`Riichi City had: ${p.leaderboardRank}  (${formatRankScore(p.rankScore)} pts)`);
  }
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
