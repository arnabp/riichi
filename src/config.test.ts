import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadTournaments } from "./config.ts";

// loadTournaments reads process.env directly, so each test sets up the exact
// environment it means to describe and restores it afterwards.
const TOUCHED = [
  "TOURNAMENT_1_ID", "TOURNAMENT_1_CHANNEL", "TOURNAMENT_1_LABEL",
  "TOURNAMENT_1_STATUS_CHANNEL", "TOURNAMENT_1_INJUSTICE_CHANNEL",
  "TOURNAMENT_2_ID", "TOURNAMENT_2_CHANNEL", "TOURNAMENT_2_LABEL",
  "TOURNAMENT_2_INJUSTICE_CHANNEL",
  "INJUSTICE_CHANNEL",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
  process.env.TOURNAMENT_1_ID = "t1";
  process.env.TOURNAMENT_1_CHANNEL = "results1";
  process.env.TOURNAMENT_1_LABEL = "Season 2";
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("report channel resolution", () => {
  it("is undefined when neither variable is set, which disables the feature", () => {
    expect(loadTournaments()[0].injusticeChannelId).toBeUndefined();
  });

  it("uses the per-tournament channel", () => {
    process.env.TOURNAMENT_1_INJUSTICE_CHANNEL = "general1";
    expect(loadTournaments()[0].injusticeChannelId).toBe("general1");
  });

  it("falls back to the global INJUSTICE_CHANNEL", () => {
    process.env.INJUSTICE_CHANNEL = "general";
    expect(loadTournaments()[0].injusticeChannelId).toBe("general");
  });

  it("prefers the per-tournament channel over the global one", () => {
    process.env.INJUSTICE_CHANNEL = "general";
    process.env.TOURNAMENT_1_INJUSTICE_CHANNEL = "general1";
    expect(loadTournaments()[0].injusticeChannelId).toBe("general1");
  });

  it("lets each tournament report somewhere different", () => {
    process.env.TOURNAMENT_1_INJUSTICE_CHANNEL = "general1";
    process.env.TOURNAMENT_2_ID = "t2";
    process.env.TOURNAMENT_2_CHANNEL = "results2";
    process.env.TOURNAMENT_2_INJUSTICE_CHANNEL = "general2";

    const configs = loadTournaments();
    expect(configs.map((c) => c.injusticeChannelId)).toEqual(["general1", "general2"]);
  });

  it("lets one tournament opt out while the other uses the global fallback", () => {
    // Tournament 2 has no override, so it inherits the global; there is no way
    // to opt a single tournament out of a global — documented, not a bug.
    process.env.INJUSTICE_CHANNEL = "general";
    process.env.TOURNAMENT_2_ID = "t2";
    process.env.TOURNAMENT_2_CHANNEL = "results2";

    const configs = loadTournaments();
    expect(configs.map((c) => c.injusticeChannelId)).toEqual(["general", "general"]);
  });
});

describe("loadTournaments", () => {
  it("still reads the other per-tournament channels", () => {
    process.env.TOURNAMENT_1_STATUS_CHANNEL = "status1";
    const [config] = loadTournaments();
    expect(config).toMatchObject({
      tournamentId: "t1",
      discordChannelId: "results1",
      statusChannelId: "status1",
      label: "Season 2",
    });
  });

  it("throws when no tournament is configured", () => {
    delete process.env.TOURNAMENT_1_ID;
    expect(() => loadTournaments()).toThrow("No tournaments configured");
  });
});
