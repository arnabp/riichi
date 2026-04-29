import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Colors,
  type SendableChannels,
} from "discord.js";
import { RCGame, RCPlayer, RCLeaderboardEntry, RCTournamentInfo } from "./riichicity.ts";
import { TournamentConfig } from "./tracker.ts";

const RANK_EMOJIS = ["🥇", "🥈", "🥉"];

export function createDiscordClient(): Client {
  return new Client({ intents: [GatewayIntentBits.Guilds] });
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
    return `${prefix} **${escapeMarkdown(e.nickname)}** — ${e.rankScore.toLocaleString("en-US")} pts *(${games})*`;
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
