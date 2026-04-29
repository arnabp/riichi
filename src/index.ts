import { createHash } from "node:crypto";
import { RiichiCityClient, RCLeaderboardEntry, RCTournamentInfo } from "./riichicity.ts";
import { GameTracker, TournamentConfig, withSessionRetry } from "./tracker.ts";
import {
  createDiscordClient,
  postGameResult,
  sendOrUpdateLeaderboard,
  sendOrRecreateQueue,
} from "./bot.ts";

// ── Config ────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);

// Each tournament is defined by a block of env vars:
//   TOURNAMENT_1_ID, TOURNAMENT_1_CHANNEL, TOURNAMENT_1_LABEL
//   TOURNAMENT_1_STATUS_CHANNEL  (optional — enables the status channel feature)
//   ... and so on for TOURNAMENT_2_*, etc.
function loadTournaments(): TournamentConfig[] {
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

// ── Status change detection ───────────────────────────────────────────────────

function leaderboardHash(entries: RCLeaderboardEntry[]): string {
  return createHash("md5")
    .update(JSON.stringify(entries.map((e) => ({ id: e.userID, score: e.rankScore, games: e.gamesPlayed }))))
    .digest("hex");
}

function queueKey(info: RCTournamentInfo): string {
  return `${info.ongoingGames}:${info.queueSize}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const tournaments = loadTournaments();
  console.log(`[Main] Loaded ${tournaments.length} tournament(s)`);

  const rcClient = new RiichiCityClient(
    requireEnv("RIICHI_EMAIL"),
    requireEnv("RIICHI_PASSWORD"),
    process.env.RIICHI_PASSWORD_IS_MD5 === "true",
    requireEnv("RIICHI_EMAIL_SUFFIX"),
    requireEnv("RIICHI_DEVICE_ID"),
  );

  const discordClient = createDiscordClient();
  await discordClient.login(requireEnv("DISCORD_TOKEN"));
  console.log(`[Main] Discord logged in as ${discordClient.user?.tag}`);

  await rcClient.login();

  const tracker = new GameTracker(rcClient, tournaments);
  await tracker.init();

  console.log(`[Main] Polling every ${POLL_INTERVAL_MS / 1000}s`);

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`[Main] ${sig} received, shutting down`);
      process.exit(0);
    });
  }

  // Per-tournament runtime state for status change detection
  const lastLeaderHash = new Map<string, string>();
  const lastQueueKey = new Map<string, string>();

  // Run one poll immediately, then loop sequentially (await each before scheduling next,
  // so a slow poll can't stack up concurrent runs)
  const loop = async () => {
    await runPoll(rcClient, tracker, discordClient, lastLeaderHash, lastQueueKey);
    setTimeout(loop, POLL_INTERVAL_MS);
  };
  loop();
}

async function runPoll(
  rcClient: RiichiCityClient,
  tracker: GameTracker,
  discordClient: ReturnType<typeof createDiscordClient>,
  lastLeaderHash: Map<string, string>,
  lastQueueKey: Map<string, string>,
) {
  try {
    await withSessionRetry(rcClient, async () => {
      // ── New completed games → games channel ──────────────────────────────
      const newGames = await tracker.poll();
      newGames.sort((a, b) => a.game.endTime - b.game.endTime);
      for (const { config, game } of newGames) {
        console.log(
          `[Main] New game in "${config.label}": ${game.paiPuId} — winner: ${game.players[0]?.nickname}`
        );
        await postGameResult(discordClient, config, game);
      }

      // ── Status updates → status channel ──────────────────────────────────
      const statusUpdates = await tracker.pollStatus();
      for (const { config, status } of statusUpdates) {
        const { tournamentId } = config;
        const msgIds = tracker.getStatusMessageIds(tournamentId);

        // Leaderboard: edit in-place if changed
        const newLeaderHash = leaderboardHash(status.leaderboard);
        if (newLeaderHash !== lastLeaderHash.get(tournamentId)) {
          lastLeaderHash.set(tournamentId, newLeaderHash);
          const id = await sendOrUpdateLeaderboard(
            discordClient, config, status.leaderboard, msgIds.leaderboardMessageId
          );
          await tracker.setLeaderboardMessageId(tournamentId, id);
          console.log(`[Main] Leaderboard updated for "${config.label}"`);
        }

        // Queue/ongoing: delete and recreate if changed
        const newQueueKey = queueKey(status.info);
        if (newQueueKey !== lastQueueKey.get(tournamentId)) {
          lastQueueKey.set(tournamentId, newQueueKey);
          const id = await sendOrRecreateQueue(
            discordClient, config, status.info, msgIds.queueMessageId
          );
          await tracker.setQueueMessageId(tournamentId, id);
          console.log(
            `[Main] Queue updated for "${config.label}": ${status.info.ongoingGames} ongoing, ${status.info.queueSize} queued`
          );
        }
      }
    });
    // console.log(`[Main] Poll complete (${Date.now() - pollStart}ms)`);
  } catch (err) {
    // Log but don't crash the poll loop
    console.error("[Main] Poll error:", err);
  }
}

main().catch((err) => {
  console.error("[Main] Fatal:", err);
  process.exit(1);
});
