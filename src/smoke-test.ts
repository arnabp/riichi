// Run with: bun run src/smoke-test.ts
// Requires: RIICHI_EMAIL, RIICHI_PASSWORD, RIICHI_EMAIL_SUFFIX, RIICHI_DEVICE_ID,
//           TOURNAMENT_1_ID in .env
// Does NOT write state, post to Discord, or modify anything.

import { RiichiCityClient } from "./riichicity.ts";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const client = new RiichiCityClient(
  requireEnv("RIICHI_EMAIL"),
  requireEnv("RIICHI_PASSWORD"),
  process.env.RIICHI_PASSWORD_IS_MD5 === "true",
  requireEnv("RIICHI_EMAIL_SUFFIX"),
  requireEnv("RIICHI_DEVICE_ID"),
);

await client.login();

const tournamentId = requireEnv("TOURNAMENT_1_ID");
const info = await client.enterTournament(tournamentId);
console.log(`classifyId: ${info.classifyId}  matchId: ${info.matchId}`);
console.log(`ongoing: ${info.ongoingGames}  queued: ${info.queueSize}`);

const games = await client.getCompletedGames(info.classifyId, 0, 5);
console.log(`\nLatest ${games.length} completed game(s):\n`);

for (const game of games) {
  const date = new Date(game.endTime * 1000).toLocaleString();
  console.log(`Game ${game.paiPuId} — ${date}`);
  for (const p of game.players) {
    console.log(`  ${p.rank}. ${p.nickname.padEnd(20)} ${p.points.toLocaleString("en-US")}`);
  }
  console.log();
}
