import { describe, it, expect } from "bun:test";
import type { Client, Message } from "discord.js";
import { parseGameId, parsePlayerCount } from "./reports.ts";
import { INJUSTICE_EMOJI, SKILL_EMOJI, buildResultEmbed, postGameResult } from "./bot.ts";
import { RCGame } from "./riichicity.ts";

// A game result is the only thing a report reaction can be serviced from, so
// these tests build the embed the same way postGameResult does and read it back
// — if the result embed's shape changes, the reactions would quietly go dead.
function resultMessage(embeds: { description?: string; footer?: string }[]): Message {
  return {
    embeds: embeds.map((e) => ({
      description: e.description ?? null,
      footer: e.footer ? { text: e.footer } : null,
    })),
  } as unknown as Message;
}

const GAME: RCGame = {
  paiPuId: "d7nbc0s6mci8rkp930d0",
  endTime: 1777253756,
  playerCount: 4,
  players: [
    { uid: 1, nickname: "partofthecreed", points: 44200, rank: 1 },
    { uid: 2, nickname: "chi", points: 27000, rank: 2 },
    { uid: 3, nickname: "ヒル", points: 20800, rank: 3 },
    { uid: 4, nickname: "KimMahjongUn", points: 8000, rank: 4 },
  ],
};

const YONMA_DESC = GAME.players
  .map((p) => `${p.rank}. **${p.nickname}** — ${p.points.toLocaleString("en-US")} *(+0.0 pts)*`)
  .join("\n");

describe("parseGameId", () => {
  it("reads the id out of a game result footer", () => {
    const msg = resultMessage([{ description: YONMA_DESC, footer: `Game ID: ${GAME.paiPuId}` }]);
    expect(parseGameId(msg)).toBe(GAME.paiPuId);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseGameId(resultMessage([{ footer: `  Game ID: ${GAME.paiPuId}  ` }])))
      .toBe(GAME.paiPuId);
  });

  it("ignores a message with no embeds or no footer", () => {
    expect(parseGameId(resultMessage([]))).toBeUndefined();
    expect(parseGameId(resultMessage([{ description: YONMA_DESC }]))).toBeUndefined();
  });

  it("does not match the bot's own report embeds", () => {
    // Report footers carry a suffix. Without the anchored match, a reaction on
    // a report would be read as a reaction on a game and loop.
    const report = resultMessage([
      { footer: `Game ID: ${GAME.paiPuId} · via InjusticeJudge` },
    ]);
    expect(parseGameId(report)).toBeUndefined();
  });

  it("ignores a footer whose id is not a Riichi City log id", () => {
    expect(parseGameId(resultMessage([{ footer: "Game ID: wxyz" }]))).toBeUndefined();
    expect(parseGameId(resultMessage([{ footer: "Standings as of today" }]))).toBeUndefined();
  });

  it("finds the footer on a later embed", () => {
    const msg = resultMessage([{ description: "intro" }, { footer: `Game ID: ${GAME.paiPuId}` }]);
    expect(parseGameId(msg)).toBe(GAME.paiPuId);
  });
});

describe("parsePlayerCount", () => {
  it("counts the players listed in a yonma result", () => {
    expect(parsePlayerCount(resultMessage([{ description: YONMA_DESC }]))).toBe(4);
  });

  it("counts a sanma result", () => {
    const desc = YONMA_DESC.split("\n").slice(0, 3).join("\n");
    expect(parsePlayerCount(resultMessage([{ description: desc }]))).toBe(3);
  });

  it("falls back to four when the description is missing or unreadable", () => {
    expect(parsePlayerCount(resultMessage([]))).toBe(4);
    expect(parsePlayerCount(resultMessage([{ description: "something else" }]))).toBe(4);
    // Out-of-range counts mean the embed is not what we think it is.
    expect(parsePlayerCount(resultMessage([{ description: "1. a\n2. b" }]))).toBe(4);
  });
});

// The reaction handler recovers everything it needs from the posted embed, so
// the embed builder and these parsers are two halves of one contract. Reading a
// real buildResultEmbed back is what keeps them from drifting apart — hand-built
// fixtures above would happily agree with a parser that had stopped working.
describe("round-trip through a real result embed", () => {
  const config = { tournamentId: "t1", discordChannelId: "c1", label: "Season 2" };

  function asMessage(game: RCGame): Message {
    const embed = buildResultEmbed(config, game);
    return { embeds: [embed.data] } as unknown as Message;
  }

  it("recovers the game id postGameResult wrote", () => {
    expect(parseGameId(asMessage(GAME))).toBe(GAME.paiPuId);
  });

  it("recovers the player count from the real player lines", () => {
    expect(parsePlayerCount(asMessage(GAME))).toBe(4);
  });

  it("recovers both for a sanma game", () => {
    const sanma: RCGame = {
      ...GAME,
      playerCount: 3,
      players: GAME.players.slice(0, 3),
    };
    expect(parseGameId(asMessage(sanma))).toBe(GAME.paiPuId);
    expect(parsePlayerCount(asMessage(sanma))).toBe(3);
  });

  it("survives a nickname full of markdown", () => {
    const nasty: RCGame = {
      ...GAME,
      players: [{ uid: 9, nickname: "**> #1|_x_", points: 44200, rank: 1 }, ...GAME.players.slice(1)],
    };
    const msg = asMessage(nasty);
    expect(parseGameId(msg)).toBe(GAME.paiPuId);
    expect(parsePlayerCount(msg)).toBe(4);
  });
});

describe("postGameResult reaction seeding", () => {
  // Enough of a client for postGameResult: a sendable channel that hands back a
  // message whose reactions we can observe.
  function fakeClient() {
    const reacted: string[] = [];
    const client = {
      channels: {
        fetch: async () => ({
          isSendable: () => true,
          send: async () => ({
            id: "m1",
            react: async (emoji: string) => {
              reacted.push(emoji);
            },
          }),
        }),
      },
    } as unknown as Client;
    return { client, reacted };
  }

  const base = { tournamentId: "t1", discordChannelId: "results", label: "Season 2" };

  it("seeds both reactions when a report channel is configured", async () => {
    const { client, reacted } = fakeClient();
    await postGameResult(client, { ...base, injusticeChannelId: "general" }, GAME);
    expect(reacted).toEqual([INJUSTICE_EMOJI, SKILL_EMOJI]);
  });

  it("adds no reactions when reporting is off for that tournament", async () => {
    // Nothing should invite a click that would have nowhere to post.
    const { client, reacted } = fakeClient();
    await postGameResult(client, base, GAME);
    expect(reacted).toEqual([]);
  });

  it("still posts the result if reacting fails", async () => {
    // A missing Add Reactions permission must not fail the poll.
    let sent = false;
    const client = {
      channels: {
        fetch: async () => ({
          isSendable: () => true,
          send: async () => {
            sent = true;
            return { id: "m1", react: async () => { throw new Error("Missing Permissions"); } };
          },
        }),
      },
    } as unknown as Client;

    await postGameResult(client, { ...base, injusticeChannelId: "general" }, GAME);
    expect(sent).toBe(true);
  });
});

describe("report reaction emojis", () => {
  it("are the two the user asked for", () => {
    // :chart_with_downwards_trend: / :chart_with_upwards_trend:
    expect(INJUSTICE_EMOJI).toBe("📉");
    expect(SKILL_EMOJI).toBe("📈");
  });

  it("are distinct, so a click maps to exactly one report", () => {
    expect(INJUSTICE_EMOJI).not.toBe(SKILL_EMOJI);
  });
});
