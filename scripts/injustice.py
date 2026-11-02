#!/usr/bin/env python3
"""Run InjusticeJudge against one Riichi City game and print the report as JSON.

The bot shells out to this (see src/injustice.ts). InjusticeJudge is a Python
library and the bot is TypeScript, so this is the seam between them.

Two things are translated here so the rest of the bot doesn't have to care:

- **Credentials.** InjusticeJudge's Riichi City fetcher reads `rc_email` and
  `rc_password` (an MD5 hash) off the environment. The bot already has the same
  account in `RIICHI_EMAIL` / `RIICHI_PASSWORD`, so we map the bot's vars onto
  the ones InjusticeJudge wants and hash the password if it isn't hashed
  already. `.env` stays the only place credentials live.
- **The cache directory.** InjusticeJudge caches raw game JSON to a relative
  `cached_games/`, so the cache lands wherever the process happens to be. We
  chdir into `INJUSTICE_CACHE_DIR` to put it somewhere persistent instead.

Output is a single JSON object on stdout:

    {"ok": true, "results": ["- Injustice detected for ...", ...]}
    {"ok": false, "error": "..."}

`results` is empty when the game was analyzed fine but nothing was found, which
is a normal outcome and not an error.
"""

import argparse
import asyncio
import hashlib
import json
import os
import sys
from pathlib import Path


def setup_credentials() -> None:
    """Map the bot's Riichi City env vars onto the ones InjusticeJudge reads."""
    email = os.environ.get("RIICHI_EMAIL")
    password = os.environ.get("RIICHI_PASSWORD")
    if not email or not password:
        raise RuntimeError("RIICHI_EMAIL and RIICHI_PASSWORD must be set")

    # The game's login API wants a hex suffix appended to the address; the bot
    # keeps it separate so it can be captured independently of the email.
    email += os.environ.get("RIICHI_EMAIL_SUFFIX", "")

    if os.environ.get("RIICHI_PASSWORD_IS_MD5") != "true":
        password = hashlib.md5(password.encode()).hexdigest()

    # `fetch_riichicity` calls dotenv.load_dotenv("config.env") before reading
    # these, and load_dotenv does not overwrite variables that are already set,
    # so setting them here wins and no secret has to be written to disk.
    os.environ["rc_email"] = email
    os.environ["rc_password"] = password


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("game_id", help="Riichi City log id (paiPuId)")
    parser.add_argument(
        "-m", "--mode", choices=["injustice", "skill", "both"], default="injustice"
    )
    parser.add_argument(
        "-p", "--players", type=int, nargs="*", default=[], choices=[0, 1, 2, 3],
        help="Seats to analyze; default is all four",
    )
    args = parser.parse_args()

    # InjusticeJudge is vendored as a submodule rather than installed.
    root = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(root / "third_party" / "InjusticeJudge"))

    cache_dir = os.environ.get("INJUSTICE_CACHE_DIR")
    if cache_dir:
        Path(cache_dir).mkdir(parents=True, exist_ok=True)
        os.chdir(cache_dir)

    try:
        setup_credentials()
        # Imported after sys.path is set up, and inside the try so that a
        # missing dependency is reported as JSON like any other failure.
        from injustice_judge import analyze_game

        look_for = {"injustice", "skill"} if args.mode == "both" else {args.mode}
        players = set(args.players) if args.players else {0, 1, 2, 3}
        results = asyncio.run(
            analyze_game(args.game_id, players, look_for=look_for)
        )
    except Exception as err:
        # The bot renders this in Discord. InjusticeJudge raises bare
        # Exceptions carrying the game server's own message ("Error 402:
        # paipuid not exist"), which reads fine alone — but a TypeError or a
        # KeyError from the parser does not, so those keep their type name.
        name = type(err).__name__
        detail = str(err) or name
        if name != "Exception" and str(err):
            detail = f"{name}: {err}"
        print(json.dumps({"ok": False, "error": detail}))
        return 1

    print(json.dumps({"ok": True, "results": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
