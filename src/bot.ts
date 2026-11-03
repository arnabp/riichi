import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  Colors,
  type Message,
  type SendableChannels,
} from "discord.js";
import { RCGame, RCPlayer, RCTournamentInfo } from "./riichicity.ts";
import { TournamentConfig } from "./tracker.ts";
import {
  SeasonSummary,
  Standing,
  standingsTable,
  dateRange,
  formatGameRef,
} from "./stats.ts";
import { gamePoints, formatGamePoints } from "./scoring.ts";
import {
  WhatIfResult,
  whatIfTable,
  describeSettings,
  balanceWarning,
} from "./whatif.ts";
import { ReportMode } from "./injustice.ts";

const RANK_EMOJIS = ["🥇", "🥈", "🥉"];

// login() resolves once the token is accepted, which is before the gateway
// READY handshake populates client.application and the guild cache. Anything
// touching those — command registration especially — has to wait for this.
export function whenReady(client: Client): Promise<void> {
  if (client.isReady()) return Promise.resolve();
  return new Promise((res) => client.once(Events.ClientReady, () => res()));
}

export function createDiscordClient(): Client {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Needed for the 📉/📈 report reactions on game results. Not privileged.
    GatewayIntentBits.GuildMessageReactions,
  ];
  // MessageContent is a privileged intent: requesting it while it is switched
  // off in the developer portal makes login fail outright. It is only needed so
  // a channel backup captures human-written messages before a purge, so it stays
  // opt-in and the purge refuses to run when the backup looks incomplete.
  if (process.env.ENABLE_MESSAGE_CONTENT === "true") {
    intents.push(GatewayIntentBits.MessageContent);
  }
  // Reactions arrive for messages the bot has not cached — anything posted
  // before the last restart. Without these partials discord.js drops those
  // events entirely, so the buttons would go dead on every redeploy.
  const partials = [Partials.Message, Partials.Channel, Partials.Reaction];
  return new Client({ intents, partials });
}

// ── Games channel ─────────────────────────────────────────────────────────────

// The two reactions the bot seeds a game result with. Clicking one posts the
// matching InjusticeJudge report — see reports.ts.
export const INJUSTICE_EMOJI = "📉";
export const SKILL_EMOJI = "📈";

export async function postGameResult(
  client: Client,
  config: TournamentConfig,
  game: RCGame,
): Promise<void> {
  const channel = await fetchTextChannel(client, config.discordChannelId);
  if (!channel) return;
  const msg = await channel.send({ embeds: [buildResultEmbed(config, game)] });
  // Only seed the buttons where a click has somewhere to post. Reading it off
  // the config keeps every caller — the poll loop and /season repost — in step.
  if (config.injusticeChannelId) await addReportReactions(msg);
}

// Best-effort: a missing Add Reactions permission should not turn a posted
// result into a failed poll, and the result itself is still correct without them.
export async function addReportReactions(msg: Message): Promise<void> {
  try {
    await msg.react(INJUSTICE_EMOJI);
    await msg.react(SKILL_EMOJI);
  } catch (err) {
    console.error(`[Bot] Could not add report reactions to ${msg.id}:`, err);
  }
}

export function buildResultEmbed(config: TournamentConfig, game: RCGame): EmbedBuilder {
  const timestamp = new Date(game.endTime * 1000);
  const description = game.players.map(formatPlayerLine).join("\n");
  return new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`Game Complete — ${config.label}`)
    .setDescription(description)
    .setFooter({ text: `Game ID: ${game.paiPuId}` })
    .setTimestamp(timestamp);
}

function formatPlayerLine(player: RCPlayer): string {
  // Raw table score plus the tournament points it was worth, since the game log
  // only carries the former.
  const earned = formatGamePoints(gamePoints(player.points, player.rank));
  return `${player.rank}. **${escapeMarkdown(player.nickname)}** — ` +
    `${formatScore(player.points)} *(${earned} pts)*`;
}

// ── Status channel — leaderboard ──────────────────────────────────────────────

export async function sendOrUpdateLeaderboard(
  client: Client,
  config: TournamentConfig,
  entries: Standing[],
  existingMessageId?: string,
): Promise<string> {
  const channel = await fetchTextChannel(client, config.statusChannelId!);
  if (!channel) throw new Error(`Status channel ${config.statusChannelId} not found`);

  const embed = buildLeaderboardEmbed(config, entries);

  if (existingMessageId) {
    try {
      const msg = await channel.messages.fetch(existingMessageId);
      await msg.edit({ embeds: [embed] });
      return existingMessageId;
    } catch {
      // Message was deleted — fall through to create a new one
    }
  }

  const msg = await channel.send({ embeds: [embed] });
  return msg.id;
}

function buildLeaderboardEmbed(config: TournamentConfig, entries: Standing[]): EmbedBuilder {
  const lines = entries.map((e) => {
    const prefix = RANK_EMOJIS[e.rank - 1] ?? `**${e.rank}.**`;
    const games = e.gamesPlayed === 1 ? "1 game" : `${e.gamesPlayed} games`;
    return `${prefix} **${escapeMarkdown(e.nickname)}** — ${formatGamePoints(e.points)} pts *(${games})*`;
  });

  return new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`🏆 ${config.label} — Standings`)
    .setDescription(lines.length ? lines.join("\n") : "*No entries yet*")
    .setTimestamp();
}

// ── Status channel — queue / ongoing ─────────────────────────────────────────

export async function sendOrRecreateQueue(
  client: Client,
  config: TournamentConfig,
  info: RCTournamentInfo,
  existingMessageId?: string,
): Promise<string> {
  const channel = await fetchTextChannel(client, config.statusChannelId!);
  if (!channel) throw new Error(`Status channel ${config.statusChannelId} not found`);

  // Always delete the old message and post fresh so Discord shows the notification pip
  if (existingMessageId) {
    try {
      const msg = await channel.messages.fetch(existingMessageId);
      await msg.delete();
    } catch {
      // Already gone — that's fine
    }
  }

  const embed = buildQueueEmbed(config, info);
  const msg = await channel.send({ embeds: [embed] });
  return msg.id;
}

function buildQueueEmbed(config: TournamentConfig, info: RCTournamentInfo): EmbedBuilder {
  const ongoingLine = info.ongoingGames === 0
    ? "No games in progress"
    : info.ongoingGames === 1
      ? "⚔️ **1** game in progress"
      : `⚔️ **${info.ongoingGames}** games in progress`;

  const queueLine = info.queueSize === 0
    ? "No players in queue"
    : info.queueSize === 1
      ? "⏳ **1** player in queue"
      : `⏳ **${info.queueSize}** players in queue`;

  return new EmbedBuilder()
    .setColor(info.ongoingGames > 0 || info.queueSize > 0 ? Colors.Green : Colors.Grey)
    .setTitle(`${config.label} — Status`)
    .setDescription(`${ongoingLine}\n${queueLine}`)
    .setTimestamp();
}

// ── Season summary ────────────────────────────────────────────────────────────

// Discord caps an embed description at 4096 chars; a long standings table is
// split across several code blocks rather than truncated.
const EMBED_DESC_LIMIT = 4000;

export function buildSeasonSummaryEmbeds(summary: SeasonSummary): EmbedBuilder[] {
  const range = dateRange(summary);
  const header = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`🏁 ${summary.seasonLabel} — Final Results`)
    .setDescription(
      `**${summary.totalGames}** games played` +
      (range ? ` · ${range}` : "") +
      `\n**${summary.players.length}** players`
    );

  const podium = summary.players.slice(0, 3).map((p, i) =>
    `${RANK_EMOJIS[i]} **${escapeMarkdown(p.nickname)}** — ` +
    `${formatGamePoints(p.leaguePoints)} pts ` +
    `*(${p.gamesPlayed} games, avg place ${p.avgPlacement.toFixed(2)})*`
  );
  if (podium.length) header.addFields({ name: "Podium", value: podium.join("\n") });

  const notable: string[] = [];
  if (summary.highestScore) {
    notable.push(`📈 Highest game — ${escapeMarkdown(formatGameRef(summary.highestScore))}`);
  }
  if (summary.lowestScore) {
    notable.push(`📉 Lowest game — ${escapeMarkdown(formatGameRef(summary.lowestScore))}`);
  }
  const most = maxBy(summary.players, (p) => p.gamesPlayed);
  if (most) notable.push(`🎲 Most games — ${escapeMarkdown(most.nickname)} (${most.gamesPlayed})`);
  const bestAvg = minBy(summary.players.filter((p) => p.gamesPlayed >= 10), (p) => p.avgPlacement);
  if (bestAvg) {
    notable.push(
      `🎯 Best average placement — ${escapeMarkdown(bestAvg.nickname)} ` +
      `(${bestAvg.avgPlacement.toFixed(2)}, min. 10 games)`
    );
  }
  if (notable.length) header.addFields({ name: "Notable", value: notable.join("\n") });

  const embeds = [header];
  for (const chunk of chunkLines(standingsTable(summary))) {
    embeds.push(
      new EmbedBuilder().setColor(Colors.Blue).setDescription("```\n" + chunk + "\n```")
    );
  }
  embeds[embeds.length - 1]
    .setFooter({ text: "1/2/3/4 = placements · AvgScore = average end score" })
    .setTimestamp();
  return embeds;
}

// Split on line boundaries so no row is cut in half.
export function chunkLines(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && current.length + line.length + 1 > EMBED_DESC_LIMIT) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

// ── What-if standings ─────────────────────────────────────────────────────────

export function buildWhatIfEmbeds(result: WhatIfResult, label: string): EmbedBuilder[] {
  const header = new EmbedBuilder()
    .setColor(Colors.Purple)
    .setTitle(`🔮 ${label} — What if?`)
    .setDescription(
      `**Proposed:** ${describeSettings(result.settings)}\n` +
      `**Current:** ${describeSettings(result.baseline)}\n` +
      `**${result.totalGames}** games replayed`
    );

  const movers = result.rows
    .filter((r) => r.rankDelta !== 0)
    .sort((a, b) => Math.abs(b.rankDelta) - Math.abs(a.rankDelta))
    .slice(0, 5)
    .map((r) =>
      `${r.rankDelta > 0 ? "📈" : "📉"} **${escapeMarkdown(r.nickname)}** — ` +
      `${r.baseRank} → ${r.rank} (${formatGamePoints(r.pointsDelta)})`
    );
  header.addFields({
    name: "Movers",
    value: movers.length ? movers.join("\n") : "*Nobody changes place.*",
  });

  const warning = balanceWarning(result);
  if (warning) header.addFields({ name: "Heads up", value: warning });

  const embeds = [header];
  for (const chunk of chunkLines(whatIfTable(result))) {
    embeds.push(
      new EmbedBuilder().setColor(Colors.Purple).setDescription("```\n" + chunk + "\n```")
    );
  }
  embeds[embeds.length - 1]
    .setFooter({ text: "Was = place under the current settings · ΔPts = points change · hypothetical only" })
    .setTimestamp();
  return embeds;
}

export async function postSeasonSummary(
  client: Client,
  channelId: string,
  summary: SeasonSummary,
): Promise<void> {
  const channel = await fetchTextChannel(client, channelId);
  if (!channel) throw new Error(`Channel ${channelId} not found`);
  // Same 10-embed / 6000-character cap as the reports — a big enough league
  // would have split the standings into chunks that overflow it together.
  for (const batch of batchEmbeds(buildSeasonSummaryEmbeds(summary))) {
    await channel.send({ embeds: batch });
  }
}

function maxBy<T>(items: T[], key: (t: T) => number): T | undefined {
  return items.reduce<T | undefined>((best, x) => (!best || key(x) > key(best) ? x : best), undefined);
}

function minBy<T>(items: T[], key: (t: T) => number): T | undefined {
  return items.reduce<T | undefined>((best, x) => (!best || key(x) < key(best) ? x : best), undefined);
}

// ── Injustice / skill reports ─────────────────────────────────────────────────

export interface ReportContext {
  mode: ReportMode;
  label: string;   // tournament label the game belongs to
  gameId: string;
  gameUrl?: string; // link back to the result message the reaction was on
}

// InjusticeJudge already formats each line as Discord markdown (bold names,
// unicode mahjong tiles), so the lines go in as-is — escaping them would show
// the asterisks instead of applying them.
export function buildReportEmbeds(results: string[], ctx: ReportContext): EmbedBuilder[] {
  const injustice = ctx.mode === "injustice";
  const title = injustice
    ? `${INJUSTICE_EMOJI} Injustices — ${ctx.label}`
    : `${SKILL_EMOJI} Skills — ${ctx.label}`;
  const color = injustice ? Colors.Red : Colors.Green;

  if (results.length === 0) {
    return [
      new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(
          injustice
            ? "*No injustices detected. A fair game, for once.*"
            : "*No skills detected. It happens.*"
        )
        .setFooter({ text: footerText(ctx) })
        .setTimestamp(),
    ];
  }

  const chunks = chunkLines(results.join("\n"));
  const embeds = chunks.map((chunk, i) =>
    new EmbedBuilder()
      .setColor(color)
      .setDescription(chunk)
      // Only the first embed carries the title, so a long report reads as one
      // report rather than several.
      .setTitle(i === 0 ? title : null)
  );
  if (ctx.gameUrl) {
    embeds[0].setURL(ctx.gameUrl);
  }
  embeds[embeds.length - 1]
    .setFooter({ text: footerText(ctx) })
    .setTimestamp();
  return embeds;
}

function footerText(ctx: ReportContext): string {
  return `Game ID: ${ctx.gameId} · via InjusticeJudge`;
}

// Discord limits a message to 10 embeds *and* 6000 characters summed across
// all of them — so chunks sized against the 4096 per-embed description limit
// cannot simply be sent ten at a time. A long report is split across messages
// instead, which Discord renders as one continuous run of embeds anyway.
const EMBED_TOTAL_LIMIT = 6000;
const EMBEDS_PER_MESSAGE = 10;

export function batchEmbeds(embeds: EmbedBuilder[]): EmbedBuilder[][] {
  const batches: EmbedBuilder[][] = [];
  let batch: EmbedBuilder[] = [];
  let size = 0;

  for (const embed of embeds) {
    const length = embedLength(embed);
    if (batch.length > 0 && (batch.length >= EMBEDS_PER_MESSAGE || size + length > EMBED_TOTAL_LIMIT)) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(embed);
    size += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

// The limit counts every rendered character, so title and footer count too.
function embedLength(embed: EmbedBuilder): number {
  const { title, description, footer, fields } = embed.data;
  return (title?.length ?? 0) +
    (description?.length ?? 0) +
    (footer?.text.length ?? 0) +
    (fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);
}

export async function postReport(
  client: Client,
  channelId: string,
  results: string[],
  ctx: ReportContext,
): Promise<void> {
  const channel = await fetchTextChannel(client, channelId);
  if (!channel) throw new Error(`Report channel ${channelId} not found`);
  for (const batch of batchEmbeds(buildReportEmbeds(results, ctx))) {
    await channel.send({ embeds: batch });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchTextChannel(client: Client, channelId: string): Promise<SendableChannels | null> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable()) {
    console.error(`[Bot] Channel ${channelId} not found or not sendable`);
    return null;
  }
  return channel;
}

export function formatScore(points: number): string {
  return points.toLocaleString("en-US");
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[_*~`|\\>\[\]#]/g, "\\$&");
}
