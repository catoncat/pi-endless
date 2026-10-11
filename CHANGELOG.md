# Changelog

## 0.1.0 — first release

One chat that never ends, for pi: Taelin's OptChat/UniiChat recipe (gist revision `3c190e0`), with the deviations listed in `docs/recipe.md`.

- `pi --mem <name>` / `/mem open <name>`: a named conversation that is logged verbatim, summarized into a binary tree in the background, and shown to the model as a bounded view each turn; `zoom`, `search`, `date` tools to get back to the original words.
- `/mem`: the map of a conversation — search every original message as you type (hits on the timeline, each saying how the model remembers it), the view's lines by day down to the original words, said vs read each turn.
- The same conversation in several windows: it follows whichever one you talk in; a turn waits while another window is answering and picks up what was said there.
- `pi-mem`: read-only CLI and MCP server (`list search view zoom message since`) for other agents and scripts; tool traffic hidden unless asked.
- Prompt cache kept across steps and turns (checked on DeepSeek, Claude, GPT and Gemini with `scripts/cache-check.mjs`); the summarizer defaults to the chat model's provider.
- Background-memory extensions (pi-blackhole and predecessors) stand by inside an open conversation.
- Batch merges wait for the most due pair instead of coarsening the newest lines when the summarizer lags (found by replaying 700 real messages).
