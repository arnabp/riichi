import { describe, it, expect } from "bun:test";
import { escapeMarkdown, formatScore } from "./bot.ts";

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
