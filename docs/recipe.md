# The recipe this code follows

Source: Victor Taelin, *UniiChat: one chat that never ends* (formerly *OptChat*), gist id: `91837951a5ce5b38f341ec1ba1df6449`.
URL: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449

pinned revision: `3c190e06f34aba0c69f49042c526093269604935` (committed 2026-10-08T01:58:24Z, the "v2" rewrite; v1 was 2026-10-04).

`node scripts/check-recipe.mjs` compares the pinned revision with the latest one and prints the diff when the gist changed. Run it before touching the design (see AGENTS.md). The gist text is not copied into this repository; the GitHub API serves any revision by its SHA.

## Where each part of the recipe lives

| Recipe (v2) | Here |
|---|---|
| §1 The log: `main/YYYY-MM-DD.jsonl`, kinds, append-only, flush, no thoughts, tool output clipped to 30,000 chars | `src/core.ts` `Memory.append`, `appendJson`, `cap`; kinds `user/pi/tool/echo/work/note` (`unii` → `pi`); logging rules in `src/index.ts` `logMessage` |
| §2 The tree: node(0,i) ≤ 512 B, node(l,i) merges children, built once, free when short | `Memory.build` |
| §3 The view: `id+n|text`, sawtooth 64–128 KB, `due = (T - last) / 2^l`, oldest on ties, only built parents, saved in `view.json` and never rebuilt | `View` (`fit`, `mostDue`), `Memory.loadViews/saveViews`; `test/core.test.ts` proves equality with Taelin's push |
| §3.3 Caching: constant tools/system, view grows at its end, Anthropic marks every 4 lines | `before_provider_request` in `src/index.ts` (4-line blocks, mark on the last whole block, request end) |
| §4 Compactions: compaction view 16–32 KB, task texts with the 512-dash ruler, 8 parallel, leaf starts when < 8 unbuilt lines before it, merge when both halves built, queue not scan | `cview`, `leafTask`, `mergeTask`, `Memory.pump` |
| §5 The prompt | `PROMPT` in `src/core.ts` (verbatim with the adaptations below) |
| §6 A turn: fresh call `[tools][system][view][message]`, view rendered before logging the message, per-turn state after the view, `zoom(id,n)`, `date(id)` | `context` handler, `buildContext`, tools `zoom`/`date` |

## Deliberate deviations (and why)

1. **Size is enforced by the harness, not by the model.** The recipe asks the model to rewrite a too-long line ("Too long … cut here") up to 5 times. Measured on real messages: DeepSeek V4 Flash and MiniMax return the same over-long line on every retry; Haiku 4.5 obeys only with thinking on (1.8 calls/node, ~$0.03/node). Here one call with `max_tokens ≈ 170` is cut at the last `; ` / sentence end to ≤ 512 bytes, and the prompt says "write the most valuable items first: the line is cut at the end if it runs over". Any model, one call.
2. **`search(text)` tool.** The recipe forbids anything but zoom. Finding an old exact name by zoom alone takes one model round-trip per tree level; search finds it in one and the model zooms the hit. Search runs over original messages only, never summaries.
3. **The previous exchange is carried verbatim** (last user message + last reply, ≤ 16 KB) after the view, so "why?" works without a zoom. The view prefix is unchanged, so caching is unaffected.
4. **Turns do not wait for summaries indefinitely.** At most 8 s, then the turn starts with `(not summarized yet: zoom it)` placeholders for the last turn's tool steps (the reply itself is in the previous exchange).
5. **Compactions use their own system prompt** (the same text, no tools) instead of sharing the turns' prompt and tools for cache reuse. pi's turn prompt includes the user's AGENTS.md, skills and cwd; sharing it with background compactions is a later optimization.
6. **A very long turn rebuilds its context from memory** instead of overflowing: the turn's steps are already logged and in the view. The recipe leaves this as "stop and continue in a new turn".
7. **Prompt wording**: "Unii" → "Pi", the device paragraph is dropped, the search tool is documented, and the byte hint says 512 bytes ≈ 70 English words ≈ 170 Chinese characters; "write in the language of the input".
8. **Not done** (by design): subagents (pi has its own), importing old chats, an always-on host, a memory inspector UI, usage ledger.

## What changed from v1 (2026-10-04) to v2 (2026-10-08), for the record

Batch merges (128 K → 64 K) instead of merging at every message; `due` measured from the pair's *last* message instead of its first; the view is saved, not refolded at start; a separate 16–32 KB compaction view instead of the whole view; a 512-dash ruler instead of a sample line; cache marks every 4 lines instead of at 50 k/80 k/100 k characters; compactions share the turns' system prompt; ready queues instead of tree scans; Haiku at xhigh effort as the compactor. pi-optchat (jonaslsaa) implements v1.
