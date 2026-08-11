import { describe, it, expect } from "bun:test";
import { escapeMarkdown, formatScore, buildWhatIfEmbeds } from "./bot.ts";
import { recalculate } from "./whatif.ts";
import { SPRING_2026_SETTINGS as S1, SEASON_2_SETTINGS as S2 } from "./scoring.ts";
import { RCGame } from "./riichicity.ts";
import { SEASON_COMMAND } from "./admin.ts";

describe("escapeMarkdown", () => {
  it("leaves plain text unchanged", () => {
    expect(escapeMarkdown("player123")).toBe("player123");
  });

  it("escapes bold/italic markers", () => {
    expect(escapeMarkdown("**bold**")).toBe("\\*\\*bold\\*\\*");
    expect(escapeMarkdown("_italic_")).toBe("\\_italic\\_");
  });

  it("escapes strikethrough and code", () => {
    expect(escapeMarkdown("~~strike~~")).toBe("\\~\\~strike\\~\\~");
    expect(escapeMarkdown("`code`")).toBe("\\`code\\`");
  });

  it("escapes block quote character", () => {
    expect(escapeMarkdown("> quote")).toBe("\\> quote");
  });

  it("escapes bracket link syntax", () => {
    expect(escapeMarkdown("[text](url)")).toBe("\\[text\\](url)");
  });

  it("escapes heading character", () => {
    expect(escapeMarkdown("# heading")).toBe("\\# heading");
  });

  it("escapes pipe character", () => {
    expect(escapeMarkdown("a|b")).toBe("a\\|b");
  });

  it("escapes backslash", () => {
    expect(escapeMarkdown("a\\b")).toBe("a\\\\b");
  });

  it("handles adversarial nickname", () => {
    expect(escapeMarkdown("> @everyone")).toBe("\\> @everyone");
  });
});

describe("formatScore", () => {
  it("formats with comma separators", () => {
    expect(formatScore(48200)).toBe("48,200");
  });

  it("handles negative scores", () => {
    expect(formatScore(-3000)).toBe("-3,000");
  });

  it("handles zero", () => {
    expect(formatScore(0)).toBe("0");
  });
});

describe("buildWhatIfEmbeds", () => {
  const games: RCGame[] = [
    {
      paiPuId: "g1",
      endTime: 100,
      playerCount: 4,
      players: [
        { uid: 1, nickname: "alpha", points: 50_000, rank: 1 },
        { uid: 2, nickname: "bravo", points: 20_000, rank: 2 },
        { uid: 3, nickname: "*charlie*", points: 18_000, rank: 3 },
        { uid: 4, nickname: "delta", points: 12_000, rank: 4 },
      ],
    },
    {
      paiPuId: "g2",
      endTime: 200,
      playerCount: 4,
      players: [
        { uid: 2, nickname: "bravo", points: 26_000, rank: 1 },
        { uid: 3, nickname: "*charlie*", points: 25_000, rank: 2 },
        { uid: 4, nickname: "delta", points: 24_900, rank: 3 },
        { uid: 1, nickname: "alpha", points: 24_100, rank: 4 },
      ],
    },
  ];

  const embeds = buildWhatIfEmbeds(recalculate(games, S1, S2), "Test League");

  it("fits inside Discord's ten-embed message limit", () => {
    expect(embeds.length).toBeGreaterThan(1);
    expect(embeds.length).toBeLessThanOrEqual(10);
  });

  it("names both rulesets and the games replayed", () => {
    const desc = embeds[0].data.description!;
    expect(desc).toContain("uma 30/10/-10/-30");
    expect(desc).toContain("uma 15/5/-5/-15");
    expect(desc).toContain("**2** games");
  });

  it("lists who moves", () => {
    const movers = embeds[0].data.fields!.find((f) => f.name === "Movers")!.value;
    expect(movers).toContain("bravo");
    expect(movers).toContain("2 → 1");
  });

  it("escapes markdown in nicknames", () => {
    const movers = embeds[0].data.fields!.find((f) => f.name === "Movers")!.value;
    expect(movers).not.toContain("*charlie*");
  });

  it("renders the standings in a code block", () => {
    expect(embeds[1].data.description).toStartWith("```\n");
  });

  it("stays quiet about balance for a zero-sum ruleset", () => {
    const zeroSum = buildWhatIfEmbeds(recalculate(games, S1, S1), "Test League");
    expect(zeroSum[0].data.fields!.some((f) => f.name === "Heads up")).toBe(false);
  });

  it("warns when the proposed ruleset does not balance", () => {
    const mistake = { ...S2, returnPoints: 30_000 };
    const unbalanced = buildWhatIfEmbeds(recalculate(games, mistake, S2), "Test League");
    expect(unbalanced[0].data.fields!.some((f) => f.name === "Heads up")).toBe(true);
  });
});

describe("SEASON_COMMAND", () => {
  it("exposes whatif with a required uma option", () => {
    const sub = SEASON_COMMAND.options!.find((o: any) => o.name === "whatif") as any;
    expect(sub).toBeDefined();
    const uma = sub.options.find((o: any) => o.name === "uma");
    expect(uma.required).toBe(true);
    for (const o of sub.options) {
      if (o.name !== "uma") expect(o.required ?? false).toBe(false);
    }
  });
});
