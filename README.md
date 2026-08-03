# riichi-discord-bot

Polls a self-built Riichi City tournament and posts finished games to Discord,
keeps a live standings message, and handles end-of-season rollover.

## How it works

The league runs as one **self-built tournament** in Riichi City. The bot logs in
with a dedicated game account, polls the tournament every `POLL_INTERVAL_MS`, and:

- posts each newly finished game to the **results channel** as an embed
- keeps a **standings** message in the status channel, edited in place
- keeps a **queue/ongoing** message, deleted and reposted so it pings

State lives in JSON files (`data/`, mounted as a Docker volume in production):

| File | Holds |
| --- | --- |
| `seen_games.json` | game IDs already posted, so restarts don't repost |
| `status_state.json` | message IDs of the standings/queue messages |
| `season_state.json` | current season number + label, and past seasons |
| `archive/sNN-<label>.json` | full frozen record of a finished season |

## Scoring

Two different numbers show up in the bot's output, and they are not in the same units:

- **Table score** — the raw end-of-game score (e.g. `83,300`). Sums to 100,000
  per four-player game. Used as-is.
- **Points** — what the game was worth in the tournament (e.g. `+103.3`). The
  standings are cumulative points.

`rankScore` from the API is fixed-point with one implied decimal: a stored
`12600` is `1260.0` in the client. Archives keep the raw value and every
user-facing render goes through `formatRankScore` (`src/stats.ts`).

The game log returns only table scores, never the points a game was worth, so
`src/scoring.ts` recomputes them:

```
points = (tableScore - 30000)/1000 + uma[rank] + 20 if 1st
uma = 15 / 5 / -5 / -15        (Season 2; Season 1 used 30 / 10 / -10 / -30)
```

The **oka is not a separate setting** — the +20 to first place falls out of the
30,000 return against a 25,000 start: `(30000 - 25000) * 4 / 1000 = 20`. It stays
in effect whatever the uma is, and dropping it leaves each table summing to -20
instead of zero.

Both seasons' settings are pinned by tests against real data: Season 1 replays
all 137 archived games against the tournament's own final standings, and
Season 2 is checked against the first game of the season. If the league's
settings change, `scoring.test.ts` fails rather than the embeds going quietly
wrong. Override via `LEAGUE_RETURN_POINTS`, `LEAGUE_UMA`, and `LEAGUE_OKA`
(see `.env.example`).

## Seasons

The league reuses **one tournament ID** across seasons — the tournament is reset
in place rather than recreated. That means the game history on Riichi City's side
is destroyed at rollover, so **the archive is the only surviving record.**

An archive holds every game (players, scores, placements, timestamps) plus the
final leaderboard verbatim — `rankScore` bakes in uma/oka rules that can't be
reliably reconstructed from raw scores, so it is preserved rather than recomputed.

### Admin commands

`/season` is gated to server Administrators, or to `DISCORD_ADMIN_IDS` when set.

| Command | Does |
| --- | --- |
| `/season status` | current season, player count, archives on disk, past seasons |
| `/season archive` | snapshot the season to disk — read-only, safe to repeat |
| `/season stats [season]` | post the season summary to the current channel |
| `/season repost [count]` | re-post the most recent game results (default 1) |
| `/season rollover <new_label> <confirm>` | archive → back up channels → purge → post results → start next season |

`rollover` requires `confirm` to exactly match the **current** season label, and
aborts if the tournament returns zero games. Pass `purge:false` to roll the
season over without clearing the channels.

### Re-posting game results

`/season repost` re-fetches the most recent games and posts them again — for
when a scoring or formatting fix landed after the games were already announced.
It **adds** messages rather than replacing them, so delete the outdated copies
yourself; the bot has no way to know which message corresponded to which game.

It also marks those games as seen, so clearing `seen_games.json` by hand is not
necessary and the poll loop will not follow up with duplicates.

### Rollover order

1. **Archive** the season from the API and verify it is non-empty.
2. **Back up** each channel's full message history to `data/archive/channels/`,
   then re-read and verify the backup.
3. **Purge** the channels (bulk delete under 14 days, one-by-one above that —
   the slow path is rate-limited to roughly one message per second).
4. **Post** the final results into the freshly cleared results channel.
5. **Reset** bot state and open the next season.

Nothing is deleted before its backup is written and verified. If the backup looks
incomplete, the purge refuses and nothing is deleted.

> **Purging needs the Message Content intent.** Without it Discord returns empty
> `content` for messages the bot did not write, so a backup would silently lose
> everything humans posted. Enable *Bot → Privileged Gateway Intents → Message
> Content* in the developer portal and set `ENABLE_MESSAGE_CONTENT=true`. If the
> channels are bot-only this is not needed — the refusal only triggers on
> unreadable non-bot messages.

The bot also needs **Manage Messages** and **Read Message History** in the
channels it will purge.

After rollover, `seen_games.json` is seeded with the archived game IDs rather
than emptied. If the tournament has not actually been reset in Riichi City yet,
an empty set would make the bot repost the entire previous season into the
just-cleared channel.

Polling is suspended for the duration of a rollover, so a poll landing mid-purge
can't repost a standings message into the channel being cleared.

### Running a rollover

The `/season` commands only exist once this version is deployed, so:

1. Push to `main` — the GitHub Actions workflow builds `ghcr.io/arnabp/riichi`.
2. Add `DISCORD_GUILD_ID` (and optionally `DISCORD_ADMIN_IDS`,
   `ENABLE_MESSAGE_CONTENT`) to the server's `.env`.
3. `docker compose pull && docker compose up -d`, then check the logs for
   `Registered /season in guild …`.
4. Run `/season archive` first and confirm the game count looks right.
5. Run `/season rollover new_label:"Summer League 2026" confirm:"Spring League 2026"`.
6. Reset the tournament in Riichi City.

Steps 4 and 5 both write an archive, so running `/season archive` first costs
nothing and confirms the whole path works before anything is deleted.

## CLI

Both read from `data/archive/` and need no Discord connection.

```bash
bun run archive              # snapshot every configured tournament
bun run archive -- 2         # just tournament 2
bun run stats                # summary of the most recent archive
bun run stats -- s01-spring-league-2026.json
bun run stats -- --player Mookjong
```

`bun run src/smoke-test.ts` checks credentials and prints the latest few games
without writing state or posting anything.

## Setup

```bash
bun install
cp .env.example .env    # then fill it in
bun run dev
```

See `.env.example` for every variable. `RIICHI_EMAIL_SUFFIX` and
`RIICHI_DEVICE_ID` have to be captured from the game client with tcpdump; the
instructions are in that file.

## Tests

```bash
bun test          # unit tests, no network
bunx tsc --noEmit # typecheck
```
