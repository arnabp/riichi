import {
  Events,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import { TournamentConfig } from "./tracker.ts";
import {
  INJUSTICE_EMOJI,
  SKILL_EMOJI,
  postReport,
  type ReportContext,
} from "./bot.ts";
import { analyzeGame, isValidGameId, InjusticeError, type ReportMode } from "./injustice.ts";

// Clicking 📉 or 📈 on a posted game result runs InjusticeJudge over that game
// and posts the report. The reaction is the whole interface, so everything
// needed to service a click has to be recoverable from the message itself —
// see `parseGameId` below.

const EMOJI_MODES: Record<string, ReportMode> = {
  [INJUSTICE_EMOJI]: "injustice",
  [SKILL_EMOJI]: "skill",
};

export interface ReportDeps {
  // Maps a game-results channel back to the tournament that posts there, which
  // carries both the label for the report and the channel it goes to. Returning
  // undefined means "not a watched channel" — either not a results channel at
  // all, or a tournament with reporting switched off.
  resolveByChannel: (channelId: string) => TournamentConfig | undefined;
}

// Game results carry their id in the embed footer, which makes the posted
// message the source of truth and means reactions keep working across restarts
// without any extra state. Anchored so the report embeds' own footer
// ("Game ID: … · via InjusticeJudge") can never be mistaken for a game result.
const FOOTER_RE = /^Game ID: ([0-9a-v]{20})$/;

export function parseGameId(msg: Message): string | undefined {
  for (const embed of msg.embeds) {
    const match = FOOTER_RE.exec(embed.footer?.text?.trim() ?? "");
    if (match) return match[1];
  }
  return undefined;
}

// The result embed lists one numbered line per player, which is the only record
// of how many seats the game had once the RCGame itself is out of scope.
export function parsePlayerCount(msg: Message): number {
  const description = msg.embeds[0]?.description ?? "";
  const count = description
    .split("\n")
    .filter((line) => /^\d+\.\s/.test(line.trim())).length;
  return count >= 3 && count <= 4 ? count : 4;
}

export function registerReportReactions(client: Client, deps: ReportDeps): void {
  // One analysis per message+mode at a time, so a flurry of clicks posts one
  // report rather than several identical ones.
  const inFlight = new Set<string>();

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    handleReaction(client, deps, inFlight, reaction, user).catch((err) => {
      console.error("[Reports] Reaction handler error:", err);
    });
  });
}

async function handleReaction(
  client: Client,
  deps: ReportDeps,
  inFlight: Set<string>,
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  // The bot seeds both reactions itself, so its own clicks arrive here first.
  if (user.bot || user.id === client.user?.id) return;

  const mode = EMOJI_MODES[reaction.emoji.name ?? ""];
  if (!mode) return;

  const config = deps.resolveByChannel(reaction.message.channelId);
  if (!config?.injusticeChannelId) return;
  const reportChannelId = config.injusticeChannelId;

  // Reactions on uncached messages arrive partial — the embeds the game id and
  // player count come from are only there after a fetch.
  let msg: Message;
  try {
    msg = reaction.message.partial ? await reaction.message.fetch() : (reaction.message as Message);
  } catch (err) {
    console.error("[Reports] Could not fetch reacted message:", err);
    return;
  }

  // Only the bot's own game-result posts carry a parseable game id, so this
  // doubles as the check that the reaction was on something reportable.
  if (msg.author.id !== client.user?.id) return;
  const gameId = parseGameId(msg);
  if (!gameId || !isValidGameId(gameId)) return;

  // Clear the click so the report can be requested again later. Needs Manage
  // Messages; without it the reaction simply stays and that user has already
  // had their report.
  reaction.users.remove(user.id).catch(() => {});

  const key = `${msg.id}:${mode}`;
  if (inFlight.has(key)) {
    console.log(`[Reports] ${mode} for ${gameId} already running, ignoring click`);
    return;
  }
  inFlight.add(key);

  const ctx: ReportContext = {
    mode,
    label: config.label,
    gameId,
    gameUrl: msg.url,
  };

  try {
    console.log(`[Reports] ${user.id} requested ${mode} report for ${gameId}`);
    // Analysis needs a login and a log fetch on first run for a game, so show
    // the typing indicator rather than leaving the channel silent.
    const channel = await client.channels.fetch(reportChannelId);
    if (channel?.isSendable()) await channel.sendTyping().catch(() => {});

    const results = await analyzeGame(gameId, mode, {
      playerCount: parsePlayerCount(msg),
    });
    await postReport(client, reportChannelId, results, ctx);
    console.log(`[Reports] Posted ${mode} report for ${gameId} (${results.length} entries)`);
  } catch (err) {
    console.error(`[Reports] ${mode} report for ${gameId} failed:`, err);
    // Report the failure where the click happened — the requester is watching
    // the results channel, not necessarily the report channel.
    const reason = err instanceof InjusticeError ? err.message : String(err);
    await msg
      .reply({ content: `❌ Could not build the ${mode} report: ${reason}` })
      .catch(() => {});
  } finally {
    inFlight.delete(key);
  }
}
