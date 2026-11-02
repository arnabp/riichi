import { describe, it, expect } from "bun:test";
import {
  isValidGameId,
  parseAnalyzerOutput,
  InjusticeError,
  analyzeGame,
} from "./injustice.ts";
import { buildReportEmbeds, batchEmbeds, INJUSTICE_EMOJI, SKILL_EMOJI } from "./bot.ts";

// A real line, so the tests break if InjusticeJudge's output stops being
// Discord markdown (bold names, unicode tiles) and starts needing conversion.
const REAL_LINE =
  "- Injustice detected for **chi** in **East 1**: you were stuck at floating " +
  "iishanten (accepting 🀌 🀎 🀕 🀘 ) for 11 draws before you finally reached tenpai";

describe("isValidGameId", () => {
  it("accepts a real Riichi City log id", () => {
    expect(isValidGameId("d7nbc0s6mci8rkp930d0")).toBe(true);
  });

  it("rejects ids of the wrong length", () => {
    expect(isValidGameId("d7nbc0s6mci8rkp930d")).toBe(false);
    expect(isValidGameId("d7nbc0s6mci8rkp930d00")).toBe(false);
    expect(isValidGameId("")).toBe(false);
  });

  it("rejects characters outside the base32 alphabet", () => {
    // w-z are not in "0123456789abcdefghijklmnopqrstuv"
    expect(isValidGameId("d7nbc0s6mci8rkp930dz")).toBe(false);
    expect(isValidGameId("D7NBC0S6MCI8RKP930D0")).toBe(false);
  });

  it("rejects things that would be read as a link or a shell argument", () => {
    expect(isValidGameId("https://tenhou.net/0/?log=x")).toBe(false);
    expect(isValidGameId("d7nbc0s6mci8rkp930d0; rm -rf /")).toBe(false);
    expect(isValidGameId("--mode=skill")).toBe(false);
  });
});

describe("parseAnalyzerOutput", () => {
  it("returns the result lines", () => {
    expect(parseAnalyzerOutput(JSON.stringify({ ok: true, results: [REAL_LINE] })))
      .toEqual([REAL_LINE]);
  });

  it("treats no findings as success, not failure", () => {
    expect(parseAnalyzerOutput(JSON.stringify({ ok: true, results: [] }))).toEqual([]);
    expect(parseAnalyzerOutput(JSON.stringify({ ok: true }))).toEqual([]);
  });

  it("ignores surrounding whitespace", () => {
    expect(parseAnalyzerOutput(`\n${JSON.stringify({ ok: true, results: [] })}\n`)).toEqual([]);
  });

  it("surfaces the analyzer's own error message", () => {
    const out = JSON.stringify({ ok: false, error: "Exception: Error 1000: no such game" });
    expect(() => parseAnalyzerOutput(out)).toThrow(InjusticeError);
    expect(() => parseAnalyzerOutput(out)).toThrow("no such game");
  });

  it("reports stderr when the process died before printing JSON", () => {
    expect(() => parseAnalyzerOutput("", "ModuleNotFoundError: No module named 'requests'"))
      .toThrow("No module named 'requests'");
  });

  it("truncates a long traceback rather than dumping it", () => {
    const huge = "Traceback\n" + "x".repeat(5000);
    let msg = "";
    try {
      parseAnalyzerOutput("", huge);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg.length).toBeLessThan(600);
    expect(msg).toContain("…");
  });

  it("rejects unreadable output", () => {
    expect(() => parseAnalyzerOutput("Segmentation fault")).toThrow("unreadable output");
  });
});

describe("analyzeGame", () => {
  it("refuses a game id it could not have come from the embed", async () => {
    // Guards the subprocess boundary: nothing reaches argv unvalidated.
    await expect(analyzeGame("not-a-game-id", "injustice")).rejects.toThrow(InjusticeError);
  });
});

describe("buildReportEmbeds", () => {
  const ctx = {
    mode: "injustice" as const,
    label: "Season 2",
    gameId: "d7nbc0s6mci8rkp930d0",
    gameUrl: "https://discord.com/channels/1/2/3",
  };

  it("passes InjusticeJudge's markdown through unescaped", () => {
    const [embed] = buildReportEmbeds([REAL_LINE], ctx);
    // The bold markers have to survive — escaping them would show asterisks.
    expect(embed.data.description).toContain("**chi**");
    expect(embed.data.description).toContain("🀌");
  });

  it("titles and links the report back to the game", () => {
    const [embed] = buildReportEmbeds([REAL_LINE], ctx);
    expect(embed.data.title).toBe(`${INJUSTICE_EMOJI} Injustices — Season 2`);
    expect(embed.data.url).toBe(ctx.gameUrl);
  });

  it("uses the skill title and emoji in skill mode", () => {
    const [embed] = buildReportEmbeds([REAL_LINE], { ...ctx, mode: "skill" });
    expect(embed.data.title).toBe(`${SKILL_EMOJI} Skills — Season 2`);
  });

  it("says so when nothing was found", () => {
    const [embed] = buildReportEmbeds([], ctx);
    expect(embed.data.description).toContain("No injustices detected");
    const [skill] = buildReportEmbeds([], { ...ctx, mode: "skill" });
    expect(skill.data.description).toContain("No skills detected");
  });

  it("always records the game id in the footer", () => {
    for (const results of [[], [REAL_LINE]]) {
      const embeds = buildReportEmbeds(results, ctx);
      expect(embeds[embeds.length - 1].data.footer?.text).toContain(ctx.gameId);
    }
  });

  it("batches embeds under Discord's per-message limits", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `- Injustice number ${i} ${"x".repeat(60)}`);
    const embeds = buildReportEmbeds(lines, ctx);
    const batches = batchEmbeds(embeds);

    // Nothing dropped or duplicated.
    expect(batches.flat()).toEqual(embeds);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(10);
      // 6000 across all embeds in one message, counting title and footer —
      // exceeding it is rejected outright as an invalid form body.
      const total = batch.reduce(
        (sum, e) =>
          sum +
          (e.data.title?.length ?? 0) +
          (e.data.description?.length ?? 0) +
          (e.data.footer?.text.length ?? 0),
        0
      );
      expect(total).toBeLessThanOrEqual(6000);
    }
  });

  it("keeps a report that fits in one message as one message", () => {
    // The common case: real reports run 1.5-3.2KB.
    const lines = Array.from({ length: 12 }, (_, i) => `- Injustice number ${i} ${"x".repeat(60)}`);
    expect(batchEmbeds(buildReportEmbeds(lines, ctx))).toHaveLength(1);
  });

  it("splits a report too long for one embed, keeping lines whole", () => {
    // Real reports run 1.5-3.2KB; this is a pathological one.
    const lines = Array.from({ length: 200 }, (_, i) => `- Injustice number ${i} ${"x".repeat(60)}`);
    const embeds = buildReportEmbeds(lines, ctx);
    expect(embeds.length).toBeGreaterThan(1);
    for (const embed of embeds) {
      expect(embed.data.description!.length).toBeLessThanOrEqual(4096);
    }
    // Only the first chunk is titled, so it reads as one report.
    expect(embeds[0].data.title).toBeTruthy();
    expect(embeds[1].data.title).toBeFalsy();
    // Nothing lost and no line cut in half.
    const rejoined = embeds.map((e) => e.data.description).join("\n");
    expect(rejoined.split("\n")).toEqual(lines);
  });
});
