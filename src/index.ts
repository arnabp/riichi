import { createHash } from "node:crypto";
import { Events, MessageFlags } from "discord.js";
import { RiichiCityClient, RCTournamentInfo } from "./riichicity.ts";
import { Standing } from "./stats.ts";
import { GameTracker, TournamentConfig, withSessionRetry } from "./tracker.ts";
import {
  createDiscordClient,
  whenReady,
  postGameResult,
  sendOrUpdateLeaderboard,
  sendOrRecreateQueue,
} from "./bot.ts";
import { loadTournaments, requireEnv, guildId } from "./config.ts";
import { SeasonStore } from "./season.ts";
import { listArchives } from "./archive.ts";
import { registerCommands, handleInteraction, type AdminContext } from "./admin.ts";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);

// ── Status change detection ───────────────────────────────────────────────────

// Hashes the standings as posted, not the tournament's own leaderboard: the
// message only needs editing when what it displays changes.
function standingsHash(entries: Standing[]): string {
  return createHash("md5")
    .update(JSON.stringify(entries.map((e) => ({ id: e.uid, score: e.points, games: e.gamesPlayed }))))
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
  await whenReady(discordClient);
  console.log(`[Main] Discord ready as ${discordClient.user?.tag}`);

  await rcClient.login();

  const tracker = new GameTracker(rcClient, tournaments);
  await tracker.init();

  const seasons = new SeasonStore();
  await seasons.load();
  for (const t of tournaments) {
    const s = await seasons.ensure(t);
    console.log(`[Main] "${s.label}" — season ${s.seasonNumber}`);
  }

  // Per-tournament runtime state for status change detection
  const lastLeaderHash = new Map<string, string>();
  const lastQueueKey = new Map<string, string>();

  const pausePolling = { paused: false };
  const adminCtx: AdminContext = {
    rcClient,
    tracker,
    seasons,
    tournaments,
    pausePolling,
    onSeasonReset: (tournamentId) => {
      lastLeaderHash.delete(tournamentId);
      lastQueueKey.delete(tournamentId);
    },
  };
  // Posting results matters more than the admin commands — if registration
  // fails (missing applications.commands scope, for instance) keep polling.
  await registerCommands(discordClient, guildId()).catch((err) => {
    console.error("[Main] Slash command registration failed:", err);
  });

  discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      const files = (await listArchives()).map((p) => p.split("/").pop()!);
      const typed = interaction.options.getFocused().toLowerCase();
      await interaction
        .respond(
          files
            .filter((f) => f.toLowerCase().includes(typed))
            .slice(0, 25)
            .map((f) => ({ name: f, value: f }))
        )
        .catch(() => {});
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    // Season commands can run for minutes (purging is rate-limited), so they are
    // handled off the poll loop and must never take the process down.
    handleInteraction(interaction, adminCtx).catch(async (err) => {
      console.error("[Main] Interaction handler error:", err);
      await interaction
        .followUp({ content: `❌ ${err}`, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    });
  });

  console.log(`[Main] Polling every ${POLL_INTERVAL_MS / 1000}s`);

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`[Main] ${sig} received, shutting down`);
      process.exit(0);
    });
  }

  // Run one poll immediately, then loop sequentially (await each before scheduling next,
  // so a slow poll can't stack up concurrent runs)
  const loop = async () => {
    if (!pausePolling.paused) {
      await runPoll(rcClient, tracker, discordClient, seasons, lastLeaderHash, lastQueueKey);
    }
    setTimeout(loop, POLL_INTERVAL_MS);
  };
  loop();
}

async function runPoll(
  rcClient: RiichiCityClient,
  tracker: GameTracker,
  discordClient: ReturnType<typeof createDiscordClient>,
  seasons: SeasonStore,
  lastLeaderHash: Map<string, string>,
  lastQueueKey: Map<string, string>,
) {
  try {
    await withSessionRetry(rcClient, async () => {
      // ── New completed games → games channel ──────────────────────────────
      const newGames = await tracker.poll();
      newGames.sort((a, b) => a.game.endTime - b.game.endTime);
      for (const { config: raw, game } of newGames) {
        // Labels come from the season store so a rollover renames posts without
        // needing an env change and redeploy.
        const config = seasons.resolve(raw);
        console.log(
          `[Main] New game in "${config.label}": ${game.paiPuId} — winner: ${game.players[0]?.nickname}`
        );
        await postGameResult(discordClient, config, game);
      }

      // ── Status updates → status channel ──────────────────────────────────
      const statusUpdates = await tracker.pollStatus();
      for (const { config: rawConfig, status } of statusUpdates) {
        const config = seasons.resolve(rawConfig);
        const { tournamentId } = config;
        const msgIds = tracker.getStatusMessageIds(tournamentId);

        // Leaderboard: edit in-place if changed
        const newLeaderHash = standingsHash(status.standings);
        if (newLeaderHash !== lastLeaderHash.get(tournamentId)) {
          lastLeaderHash.set(tournamentId, newLeaderHash);
          const id = await sendOrUpdateLeaderboard(
            discordClient, config, status.standings, msgIds.leaderboardMessageId
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
