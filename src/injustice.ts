import { resolve } from "node:path";

// Bridge to InjusticeJudge (https://github.com/Longhorn-Riichi/InjusticeJudge),
// vendored as a submodule under third_party/ and driven by scripts/injustice.py.
// It is a Python library, so this shells out rather than linking against it.

export type ReportMode = "injustice" | "skill";

// Riichi City log ids are base32 (0-9a-v). InjusticeJudge decides a link is a
// Riichi City id by this charset, so anything else would be misread as a Tenhou
// or Mahjong Soul URL — and ids reach here parsed out of a Discord embed, so
// they are checked before being passed to a subprocess.
const GAME_ID_RE = /^[0-9a-v]{20}$/;

const PYTHON = process.env.INJUSTICE_PYTHON ?? "python3";
const SCRIPT = process.env.INJUSTICE_SCRIPT ?? resolve("scripts/injustice.py");
// Raw game logs are cached here so the second report on a game skips the fetch.
const CACHE_DIR = process.env.INJUSTICE_CACHE_DIR ?? resolve("data/injustice-cache");
// Analysis itself takes a second or two; the budget is mostly for the login and
// log fetch, which talk to the game server and can hang.
const TIMEOUT_MS = Number(process.env.INJUSTICE_TIMEOUT_MS ?? 120_000);

export function isValidGameId(gameId: string): boolean {
  return GAME_ID_RE.test(gameId);
}

export class InjusticeError extends Error {}

interface AnalyzerOutput {
  ok: boolean;
  results?: string[];
  error?: string;
}

// The script prints one JSON object on stdout. Anything else means it died
// before it could report a failure itself (missing interpreter, OOM kill), so
// stderr is the only clue and gets surfaced.
export function parseAnalyzerOutput(stdout: string, stderr = ""): string[] {
  const text = stdout.trim();
  if (!text) {
    throw new InjusticeError(
      `Analyzer produced no output${stderr.trim() ? `: ${tail(stderr)}` : ""}`
    );
  }

  let parsed: AnalyzerOutput;
  try {
    parsed = JSON.parse(text) as AnalyzerOutput;
  } catch {
    throw new InjusticeError(`Analyzer produced unreadable output: ${tail(text)}`);
  }

  if (!parsed.ok) throw new InjusticeError(parsed.error ?? "Analyzer failed");
  return parsed.results ?? [];
}

// Keeps a long Python traceback from becoming a wall of text in Discord.
function tail(text: string, limit = 400): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

export interface AnalyzeOptions {
  playerCount?: number;
}

// Returns one formatted line per (round, player) that had something to report —
// empty when the game was analyzed fine and nothing turned up.
export async function analyzeGame(
  gameId: string,
  mode: ReportMode,
  { playerCount = 4 }: AnalyzeOptions = {},
): Promise<string[]> {
  if (!isValidGameId(gameId)) {
    throw new InjusticeError(`Not a Riichi City game id: ${gameId}`);
  }

  const seats = Array.from({ length: Math.min(Math.max(playerCount, 1), 4) }, (_, i) => String(i));

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([PYTHON, SCRIPT, gameId, "-m", mode, "-p", ...seats], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, INJUSTICE_CACHE_DIR: CACHE_DIR },
    });
  } catch (err) {
    // Missing interpreter or script — a deployment problem, not a bad game.
    throw new InjusticeError(
      `Could not run the analyzer (${PYTHON} ${SCRIPT}): ${err instanceof Error ? err.message : err}`
    );
  }

  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    // A killed process has no output to parse, so distinguish the timeout here
    // rather than reporting it as empty output.
    if (proc.killed && !stdout.trim()) {
      throw new InjusticeError(`Analysis timed out after ${TIMEOUT_MS / 1000}s`);
    }
    return parseAnalyzerOutput(stdout, stderr);
  } finally {
    clearTimeout(timer);
  }
}
