import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Colors,
  type SendableChannels,
} from "discord.js";
import { RCGame, RCPlayer, RCLeaderboardEntry, RCTournamentInfo } from "./riichicity.ts";
import { TournamentConfig } from "./tracker.ts";
import {
  SeasonSummary,
  standingsTable,
  dateRange,
  formatGameRef,
  formatRankScore,
} from "./stats.ts";

const RANK_EMOJIS = ["🥇", "🥈", "🥉"];

// login() resolves once the token is accepted, which is before the gateway
// READY handshake populates client.application and the guild cache. Anything
// touching those — command registration especially — has to wait for this.
export function whenReady(client: Client): Promise<void> {
  if (client.isReady()) return Promise.resolve();
  return new Promise((res) => client.once(Events.ClientReady, () => res()));
}

export function createDiscordClient(): Client {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  // MessageContent is a privileged intent: requesting it while it is switched
  // off in the developer portal makes login fail outright. It is only needed so
  // a channel backup captures human-written messages before a purge, so it stays
  // opt-in and the purge refuses to run when the backup looks incomplete.
  if (process.env.ENABLE_MESSAGE_CONTENT === "true") {
    intents.push(GatewayIntentBits.MessageContent);
  }
  return new Client({ intents });
}

// ── Games channel ─────────────────────────────────────────────────────────────

export async function postGameResult(
  client: Client,
  config: TournamentConfig,
  game: RCGame
): Promise<void> {
  const channel = await fetchTextChannel(client, config.discordChannelId);
  if (!channel) return;
  await channel.send({ embeds: [buildResultEmbed(config, game)] });
}

function buildResultEmbed(config: TournamentConfig, game: RCGame): EmbedBuilder {
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
  return `${player.rank}. **${escapeMarkdown(player.nickname)}** — ${formatScore(player.points)}`;
}

// ── Status channel — leaderboard ──────────────────────────────────────────────

export async function sendOrUpdateLeaderboard(
  client: Client,
  config: TournamentConfig,
  entries: RCLeaderboardEntry[],
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

function buildLeaderboardEmbed(config: TournamentConfig, entries: RCLeaderboardEntry[]): EmbedBuilder {
  const lines = entries.map((e) => {
    const prefix = RANK_EMOJIS[e.rank - 1] ?? `**${e.rank}.**`;
    const games = e.gamesPlayed === 1 ? "1 game" : `${e.gamesPlayed} games`;
    return `${prefix} **${escapeMarkdown(e.nickname)}** — ${formatRankScore(e.rankScore)} pts *(${games})*`;
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
    `${p.rankScore != null ? formatRankScore(p.rankScore) : "—"} pts ` +
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
  for (const chunk of chunkTable(standingsTable(summary))) {
    embeds.push(
      new EmbedBuilder().setColor(Colors.Blue).setDescription("```\n" + chunk + "\n```")
    );
  }
  embeds[embeds.length - 1].setFooter({ text: "Avg = average placement · Avg± = average end score" })
    .setTimestamp();
  return embeds;
}

// Split on line boundaries so no row is cut in half.
function chunkTable(text: string): string[] {
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

export async function postSeasonSummary(
  client: Client,
  channelId: string,
  summary: SeasonSummary,
): Promise<void> {
  const channel = await fetchTextChannel(client, channelId);
  if (!channel) throw new Error(`Channel ${channelId} not found`);
  // Discord allows up to 10 embeds per message.
  const embeds = buildSeasonSummaryEmbeds(summary);
  for (let i = 0; i < embeds.length; i += 10) {
    await channel.send({ embeds: embeds.slice(i, i + 10) });
  }
}

function maxBy<T>(items: T[], key: (t: T) => number): T | undefined {
  return items.reduce<T | undefined>((best, x) => (!best || key(x) > key(best) ? x : best), undefined);
}

function minBy<T>(items: T[], key: (t: T) => number): T | undefined {
  return items.reduce<T | undefined>((best, x) => (!best || key(x) < key(best) ? x : best), undefined);
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
