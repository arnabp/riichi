import {
  Client,
  EmbedBuilder,
  Colors,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChatInputCommandInteraction,
  type GuildTextBasedChannel,
} from "discord.js";
import { RiichiCityClient } from "./riichicity.ts";
import { GameTracker, TournamentConfig } from "./tracker.ts";
import { SeasonStore } from "./season.ts";
import { buildArchive, saveArchive, loadArchive, listArchives, SeasonArchive } from "./archive.ts";
import { summarize } from "./stats.ts";
import { postSeasonSummary, postGameResult, buildWhatIfEmbeds } from "./bot.ts";
import { ScoringSettings, SETTINGS } from "./scoring.ts";
import { recalculate, parseUma, sameSettings } from "./whatif.ts";
import { purgeChannelSafely, PurgeRefused } from "./purge.ts";
import { loadAdminIds } from "./config.ts";

export const SEASON_COMMAND = new SlashCommandBuilder()
  .setName("season")
  .setDescription("League season administration")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName("status").setDescription("Show the current season and whether it has been archived"))
  .addSubcommand((s) =>
    s.setName("archive").setDescription("Snapshot the current season's games to disk (read-only, safe to repeat)"))
  .addSubcommand((s) =>
    s.setName("stats")
      .setDescription("Post the season summary to this channel")
      .addStringOption((o) =>
        o.setName("season").setDescription("Archived season file (defaults to a live snapshot)").setAutocomplete(true)))
  .addSubcommand((s) =>
    s.setName("whatif")
      .setDescription("Re-score the season under different uma/oka and show the standings it would give")
      .addStringOption((o) =>
        o.setName("uma")
          .setDescription("Placement bonuses, e.g. '30,10,-10,-30' or the shorthand '30,10'")
          .setRequired(true))
      .addNumberOption((o) =>
        o.setName("oka").setDescription("Bonus to 1st place (default: the current season's)"))
      .addNumberOption((o) =>
        o.setName("return_points")
          .setDescription("Score each player returns to (default: the current season's)"))
      .addStringOption((o) =>
        o.setName("season")
          .setDescription("Archived season file (defaults to the live season)")
          .setAutocomplete(true))
      .addBooleanOption((o) =>
        o.setName("private").setDescription("Show it only to you instead of posting in the channel (default false)")))
  .addSubcommand((s) =>
    s.setName("repost")
      .setDescription("Re-post recent game results (after a scoring or formatting fix)")
      .addIntegerOption((o) =>
        o.setName("count")
          .setDescription("How many of the most recent games to re-post (default 1)")
          .setMinValue(1)
          .setMaxValue(20)))
  .addSubcommand((s) =>
    s.setName("rollover")
      .setDescription("Archive, clear the channels, and start the next season")
      .addStringOption((o) =>
        o.setName("new_label").setDescription("Label for the new season, e.g. 'Summer League 2026'").setRequired(true))
      .addStringOption((o) =>
        o.setName("confirm")
          .setDescription("Type the CURRENT season label exactly, to confirm")
          .setRequired(true))
      .addBooleanOption((o) =>
        o.setName("purge").setDescription("Clear the channels (default true)")))
  .toJSON();

export interface AdminContext {
  rcClient: RiichiCityClient;
  tracker: GameTracker;
  seasons: SeasonStore;
  tournaments: TournamentConfig[];
  // Clears the poll loop's in-memory "has this changed?" caches. Without it the
  // standings/queue messages deleted by a purge would not be reposted until the
  // underlying values happened to change.
  onSeasonReset?: (tournamentId: string) => void;
  // Suspends polling for the duration of a rollover. A purge takes minutes, and
  // a poll landing mid-purge would repost a standings message into the channel
  // being cleared, leaving a stray message from the old season behind.
  pausePolling?: { paused: boolean };
}

export async function registerCommands(client: Client, guildId?: string): Promise<void> {
  if (guildId) {
    // Guild commands appear immediately; global ones take up to an hour.
    const guild = await client.guilds.fetch(guildId);
    await guild.commands.set([SEASON_COMMAND]);
    console.log(`[Admin] Registered /season in guild ${guildId}`);
  } else {
    if (!client.application) throw new Error("Client has no application — registered before ready?");
    await client.application.commands.set([SEASON_COMMAND]);
    console.log("[Admin] Registered /season globally (may take up to an hour to appear)");
  }
}

export function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  const allowlist = loadAdminIds();
  // If an explicit allowlist is configured it is authoritative; otherwise fall
  // back to Discord's own Administrator permission gate on the command.
  if (allowlist.size > 0) return allowlist.has(interaction.user.id);
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

export async function handleInteraction(
  interaction: ChatInputCommandInteraction,
  ctx: AdminContext,
): Promise<void> {
  if (interaction.commandName !== "season") return;

  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: "You do not have permission to run season commands.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();
  try {
    switch (sub) {
      case "status":   return await handleStatus(interaction, ctx);
      case "archive":  return await handleArchive(interaction, ctx);
      case "stats":    return await handleStats(interaction, ctx);
      case "whatif":   return await handleWhatIf(interaction, ctx);
      case "repost":   return await handleRepost(interaction, ctx);
      case "rollover": return await handleRollover(interaction, ctx);
    }
  } catch (err) {
    console.error(`[Admin] /season ${sub} failed:`, err);
    await report(interaction, `❌ \`/season ${sub}\` failed: ${errText(err)}`);
  }
}

// The tournament a command applies to. Multi-tournament setups run the command
// in one of the configured channels to pick which.
function resolveTournament(
  interaction: ChatInputCommandInteraction,
  ctx: AdminContext,
): TournamentConfig {
  if (ctx.tournaments.length === 1) return ctx.tournaments[0];
  const match = ctx.tournaments.find(
    (t) => t.discordChannelId === interaction.channelId || t.statusChannelId === interaction.channelId
  );
  if (!match) {
    throw new Error(
      "Multiple tournaments are configured — run this in one of their results or status channels."
    );
  }
  return match;
}

// ── status ────────────────────────────────────────────────────────────────────

async function handleStatus(interaction: ChatInputCommandInteraction, ctx: AdminContext) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const config = resolveTournament(interaction, ctx);
  const season = ctx.seasons.current(config);
  const info = await ctx.rcClient.enterTournament(config.tournamentId);
  const leaderboard = await ctx.rcClient.getLeaderboard(info.classifyId, info.matchId);
  const archives = await listArchives();

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`${season.label} — Season ${season.seasonNumber}`)
    .addFields(
      { name: "Tournament", value: `\`${config.tournamentId}\``, inline: true },
      { name: "Players ranked", value: String(leaderboard.length), inline: true },
      { name: "Started", value: season.startedAt.slice(0, 10), inline: true },
      { name: "Results channel", value: `<#${config.discordChannelId}>`, inline: true },
      {
        name: "Status channel",
        value: config.statusChannelId ? `<#${config.statusChannelId}>` : "*not configured*",
        inline: true,
      },
      {
        name: "Archives on disk",
        value: archives.length
          ? archives.map((a) => `\`${a.split("/").pop()}\``).join("\n")
          : "*none yet — run `/season archive`*",
      },
    );

  const past = ctx.seasons.past(config);
  if (past.length) {
    embed.addFields({
      name: "Past seasons",
      value: past
        .map((s) => `**${s.seasonNumber}.** ${s.label} — ended ${s.endedAt?.slice(0, 10) ?? "?"}`)
        .join("\n"),
    });
  }
  await interaction.editReply({ embeds: [embed] });
}

// ── archive ───────────────────────────────────────────────────────────────────

async function snapshot(ctx: AdminContext, config: TournamentConfig): Promise<{ archive: SeasonArchive; path: string }> {
  const season = await ctx.seasons.ensure(config);
  const archive = await buildArchive(
    ctx.rcClient,
    { ...config, label: season.label },
    season.seasonNumber,
  );
  const path = await saveArchive(archive);
  return { archive, path };
}

async function handleArchive(interaction: ChatInputCommandInteraction, ctx: AdminContext) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const config = resolveTournament(interaction, ctx);
  const { archive, path } = await snapshot(ctx, config);
  await ctx.seasons.update(config.tournamentId, { archivePath: path });
  await interaction.editReply(
    `✅ Archived **${archive.seasonLabel}** — ${archive.games.length} games, ` +
    `${archive.finalLeaderboard.length} ranked players.\n\`${path}\``
  );
}

// ── stats ─────────────────────────────────────────────────────────────────────

async function handleStats(interaction: ChatInputCommandInteraction, ctx: AdminContext) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const config = resolveTournament(interaction, ctx);
  const chosen = interaction.options.getString("season");

  let archive: SeasonArchive;
  if (chosen) {
    const match = (await listArchives()).find((p) => p.endsWith(chosen));
    if (!match) throw new Error(`No archive named \`${chosen}\``);
    archive = await loadArchive(match);
  } else {
    archive = (await snapshot(ctx, config)).archive;
  }

  await postSeasonSummary(interaction.client, interaction.channelId, summarize(archive));
  await interaction.editReply(`✅ Posted the summary for **${archive.seasonLabel}**.`);
}

// ── whatif ────────────────────────────────────────────────────────────────────

async function handleWhatIf(interaction: ChatInputCommandInteraction, ctx: AdminContext) {
  // Posts into the channel it was run in — a what-if is for the league to argue
  // over. `private:true` keeps it to the caller.
  const isPrivate = interaction.options.getBoolean("private") ?? false;
  await interaction.deferReply(isPrivate ? { flags: MessageFlags.Ephemeral } : {});
  const config = resolveTournament(interaction, ctx);

  // Anything not given stays at the current league setting, so `uma:30,10` on
  // its own answers "what if only the uma changed?".
  const settings: ScoringSettings = {
    returnPoints: interaction.options.getNumber("return_points") ?? SETTINGS.returnPoints,
    oka: interaction.options.getNumber("oka") ?? SETTINGS.oka,
    uma: parseUma(interaction.options.getString("uma", true)),
  };

  const chosen = interaction.options.getString("season");
  let games: SeasonArchive["games"];
  let label: string;
  if (chosen) {
    const match = (await listArchives()).find((p) => p.endsWith(chosen));
    if (!match) throw new Error(`No archive named \`${chosen}\``);
    const archive = await loadArchive(match);
    games = archive.games;
    label = archive.seasonLabel;
  } else {
    // Deliberately not snapshot() — a what-if is a read-only question and has no
    // business overwriting the season's archive on disk.
    const season = await ctx.seasons.ensure(config);
    const archive = await buildArchive(ctx.rcClient, { ...config, label: season.label }, season.seasonNumber);
    games = archive.games;
    label = archive.seasonLabel;
  }

  if (games.length === 0) {
    await interaction.editReply("No games recorded for this season yet — nothing to re-score.");
    return;
  }

  const result = recalculate(games, settings);
  // Discord allows 10 embeds per message; a season's standings needs 2–3.
  await interaction.editReply({
    content: sameSettings(settings, result.baseline)
      ? "*Those are the settings already in use, so this is just the current standings.*"
      : undefined,
    embeds: buildWhatIfEmbeds(result, label).slice(0, 10),
  });
}

// ── repost ────────────────────────────────────────────────────────────────────

async function handleRepost(interaction: ChatInputCommandInteraction, ctx: AdminContext) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const config = resolveTournament(interaction, ctx);
  const season = ctx.seasons.current(config);
  const count = interaction.options.getInteger("count") ?? 1;

  const info = await ctx.rcClient.enterTournament(config.tournamentId);
  const { games } = await ctx.rcClient.getCompletedGamesPage(info.classifyId, 0, count);
  if (games.length === 0) {
    await interaction.editReply("No completed games to re-post — the tournament has none yet.");
    return;
  }

  // Same order the poll loop uses, so a re-post reads chronologically.
  const ordered = [...games].sort((a, b) => a.endTime - b.endTime);
  const labelled = { ...config, label: season.label };
  for (const game of ordered) {
    await postGameResult(interaction.client, labelled, game);
  }

  // These may not be in the seen set — if the state file was cleared, or a game
  // finished between the fetch and now. Marking them stops the next poll from
  // posting a duplicate.
  await ctx.tracker.markSeen(ordered.map((g) => g.paiPuId));

  await interaction.editReply(
    `✅ Re-posted ${ordered.length} game(s) to <#${config.discordChannelId}>.\n` +
    `Delete the outdated copies yourself — this adds new messages rather than replacing them.`
  );
}

// ── rollover ──────────────────────────────────────────────────────────────────

async function handleRollover(interaction: ChatInputCommandInteraction, ctx: AdminContext) {
  await interaction.deferReply();
  try {
    await runRollover(interaction, ctx);
  } finally {
    // Always resume polling, including on an aborted or failed rollover.
    if (ctx.pausePolling) ctx.pausePolling.paused = false;
  }
}

async function runRollover(interaction: ChatInputCommandInteraction, ctx: AdminContext) {
  const config = resolveTournament(interaction, ctx);
  const season = await ctx.seasons.ensure(config);
  const newLabel = interaction.options.getString("new_label", true);
  const confirm = interaction.options.getString("confirm", true);
  const doPurge = interaction.options.getBoolean("purge") ?? true;

  if (confirm !== season.label) {
    await interaction.editReply(
      `❌ Confirmation did not match. To roll over, set \`confirm\` to the current season label: ` +
      `**${season.label}**`
    );
    return;
  }

  const log: string[] = [];
  // A purge can run for minutes, and Discord invalidates the interaction token
  // after 15. Losing the progress message must not abort the rollover, so
  // failures to edit are logged and swallowed.
  const say = async (line: string) => {
    log.push(line);
    console.log(`[Admin] rollover: ${line}`);
    await interaction.editReply(log.join("\n")).catch(() => {
      console.warn("[Admin] Could not update the progress message (token expired?)");
    });
  };

  if (ctx.pausePolling) ctx.pausePolling.paused = true;

  // 1. Archive the outgoing season — everything downstream depends on this
  //    having succeeded, because the tournament reset destroys the source data.
  await say(`⏳ Archiving **${season.label}**…`);
  const { archive, path } = await snapshot(ctx, config);
  if (archive.games.length === 0) {
    await say(
      `⚠️ The tournament returned **0 games**, so there is nothing to preserve and nothing to ` +
      `summarise. Aborting — if the tournament was already reset, run \`/season rollover\` with ` +
      `\`purge:false\`, or purge the channels manually.`
    );
    return;
  }
  await say(`✅ Archived ${archive.games.length} games → \`${path.split("/").pop()}\``);

  const summary = summarize(archive);
  const slug = `s${String(archive.seasonNumber).padStart(2, "0")}`;

  // 2. Back up and clear the channels. purgeChannelSafely dumps each channel
  //    to disk and verifies the dump before deleting anything.
  if (doPurge) {
    const channels = [config.discordChannelId, config.statusChannelId].filter(Boolean) as string[];
    for (const id of channels) {
      const channel = await interaction.client.channels.fetch(id);
      if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        await say(`⚠️ Skipped <#${id}> — not a readable text channel.`);
        continue;
      }
      await say(`⏳ Backing up and clearing <#${id}>…`);
      try {
        const { dump, purge, dumpPath } = await purgeChannelSafely(
          channel as GuildTextBasedChannel, slug
        );
        await say(
          `✅ <#${id}> — backed up ${dump.messageCount} messages to ` +
          `\`${dumpPath.split("/").pop()}\`, deleted ${purge.bulkDeleted + purge.slowDeleted}` +
          (purge.failed ? ` (${purge.failed} could not be deleted)` : "")
        );
      } catch (err) {
        if (err instanceof PurgeRefused) {
          await say(`🛑 ${err.message}\n\nRollover aborted — nothing was deleted.`);
          return;
        }
        throw err;
      }
    }
  }

  // 3. Post the final results into the freshly cleared results channel.
  await postSeasonSummary(interaction.client, config.discordChannelId, summary);
  await say(`✅ Posted final results to <#${config.discordChannelId}>`);

  // 4. Reset bot state and open the new season.
  await ctx.tracker.resetSeason(config.tournamentId, archive.games.map((g) => g.paiPuId));
  await ctx.tracker.refreshTournament(config.tournamentId);
  ctx.onSeasonReset?.(config.tournamentId);
  const next = await ctx.seasons.rollover(config, newLabel, path);

  await say(
    `🎉 **${newLabel}** (season ${next.seasonNumber}) is live.\n` +
    `Reset the tournament in Riichi City if you have not already — the bot will start ` +
    `posting as soon as new games finish.`
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function report(interaction: ChatInputCommandInteraction, content: string) {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(content).catch(() => {});
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
