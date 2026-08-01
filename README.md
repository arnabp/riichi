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
| `/season rollover <new_label> <confirm>` | archive → back up channels → purge → post results → start next season |

`rollover` requires `confirm` to exactly match the **current** season label, and
aborts if the tournament returns zero games. Pass `purge:false` to roll the
season over without clearing the channels.

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
