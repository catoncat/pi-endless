# pi-endless — notes for agents working on this repository

What this is: a pi extension that implements Victor Taelin's OptChat/UniiChat recipe (one chat that never ends; the chat itself is the memory). Design: `docs/DESIGN.md`. Recipe mapping and deliberate deviations: `docs/recipe.md`.

## Before changing the design: check the upstream recipe

The design follows a specific revision of the upstream gist. Before any change to `src/core.ts`, the prompts, the view math or `docs/recipe.md`, run:

```sh
node scripts/check-recipe.mjs
```

- exit 0: the pinned revision is still the latest; go ahead.
- exit 2: the gist changed. Read the printed diff first. Then, in this order: list what changed in the design (not wording), decide per item whether to follow it or keep a deliberate deviation (add it to `docs/recipe.md` with the reason), update `pinned revision` in `docs/recipe.md`, run `node scripts/check-recipe.mjs --write` to refresh `docs/upstream/optchat.md`, change the code, run the tests. Tell the user what upstream changed and what you did about it.
- exit 3: `docs/upstream/optchat.md` is missing (a fresh clone) or not the pinned revision verbatim; run with `--write`.
- exit 1: network/API problem; say so and continue, but do not update the pinned revision.

`docs/upstream/optchat.md` is the upstream text, our theory source: cite it, never edit it by hand (only `--write` touches it). The gist has no license, so it stays local: gitignored, never committed, never packaged.

## Working rules

- `src/core.ts` is pure logic (log, tree, view, scheduler, prompts); `src/index.ts` is the pi integration; `src/map.ts` the `/mem` screen; `src/api.ts` + `src/cli.ts` the read-only API for everyone else (`pi-mem`, CLI and MCP; `npm run build` bundles it to `dist/pi-mem.mjs`, which the local `~/.local/bin/pi-mem` links to: rebuild after changing them). The API never writes and hides tool traffic unless asked: keep both. `src/i18n.ts` holds the two-language UI strings (`t("en", "zh")`). Model-facing text (prompts, tool descriptions) is English only.
- Tests: `bun test`. They cover the parts that fail silently: merge order equals Taelin's push, batched merges keep the view prefix stable, the view survives a restart byte for byte, size cutting, retries, and the whole request staying a prefix of the next one (`test/index.test.ts` drives the real hooks with a fake pi and a moving clock: anything per-call placed before the run's messages breaks it). `node scripts/cache-check.mjs <provider/model>` confirms it against a real provider after changes to the turn assembly. Add a test only for a behavior with regression risk; say why.
- Type check: `npm run check` (or `tsc -p tsconfig.local.json` when developing against a local pi install).
- Say nothing the user cannot act on: no toasts or card lines about internals (compaction cancelled, another extension's quirks, context rebuilt). Make it work silently or fix it; put it in `MEM_TRACE`.
- Keep the opt-in contract: with no conversation open, the extension must change nothing visible (no tools declared, no prompt changes, no hooks that alter requests).
- Keep the two cache invariants: tools and system prompt are byte-stable across turns; the view only grows at its end between batches. Anything that rewrites earlier view lines costs every user a cache miss.
- Sizes are UTF-8 bytes, never tokens.
- Style: tabs, double quotes, short comments that say why. Chinese comments are fine in code; user-facing strings go through `t()`.

## Manual verification (no TUI in CI)

```sh
MEM_HOME=$(mktemp -d) pi --mem test -p "remember: the project code name is bluewhale, db port 5433"
MEM_HOME=... pi --mem test -p "what is the code name and the port?"          # answered from the view
MEM_DEBUG=/tmp/payload.json MEM_HOME=... pi --mem test -p "say ok"            # inspect exactly what the model received
```

`node scripts/smoke.mjs` drives two `pi --mode rpc` processes through open / chat / status / rename / close / reopen by old name / recall / two windows taking turns (no question asked, a turn queues behind the other window's) / delete / prune and answers any dialogs itself (needs a logged-in model; `SMOKE_MODEL=provider/id`, `SMOKE_VERBOSE=1`). Run it after touching `src/index.ts`. Only the look of the TUI (banner card, the `/mem` map, editor views, pickers) still needs a human: run pi in tmux, open `/mem`, `tmux capture-pane -e -p | aha` and look at it.
