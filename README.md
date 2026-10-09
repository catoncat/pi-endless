# pi-endless

**One chat that never ends, for [pi](https://github.com/earendil-works/pi).** Open a named conversation, talk for months, close your laptop, come back: the agent still has everything. No compaction, nothing lost, constant context size.

An implementation of Victor Taelin's [OptChat / UniiChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): the chat itself is the memory. Every message is logged verbatim; a cheap model compresses the log into a binary tree of one-line summaries in the background; each turn the model sees a bounded **view** of the whole history (recent lines fine, old ones coarse) and **zooms** into any line down to the original message.

Opt-in by design. Until you open a conversation, pi is exactly pi.

[中文说明](#中文)

## Install

```sh
pi install git:github.com/catoncat/pi-endless
```

Requires pi ≥ 1.0.4 and a model to summarize with (any provider you are logged in to; a cheap one is picked automatically).

## Use

```sh
pi --mem main            # open (or create) the conversation "main"
```

or, inside any pi session, `/mem open main`. You get a fresh session bound to that conversation, a card showing where you left off, and three extra tools for the model: `zoom`, `search`, `date`. Then just chat.

| Command | What it does |
|---|---|
| `/mem` | status (or the conversation picker when none is open) |
| `/mem open <name>` | open or create a conversation in a new session; `<Tab>` completes names |
| `/mem close` | back to plain pi (new session) |
| `/mem rename <new>` | rename; the old name keeps a pointer so old sessions still find it |
| `/mem view` | the whole view, as the model sees it |
| `/mem zoom 1024+256` / `/mem search <text>` | look things up yourself |
| `/mem model` | choose the summarizing model (applies to new conversations too) |
| `/mem list` | your conversations |

One pi writes a conversation at a time. Opening it from a second pi offers **read-only** (search and zoom, nothing logged) or **take over** (the first pi becomes read-only).

Data lives in `~/.pi/memory/<name>/` (`MEM_HOME` to change): `main/*.jsonl` the log, `tree/*.jsonl` the summaries, `view.json`, `config.json`. Plain files; back them up like any other.

UI language follows `LANG` (`zh*` → Chinese), or set `MEM_LANG=en|zh`.

## How it works (short)

- **Log**: `user`, `pi` (replies), `tool`, `echo` (results, clipped to 30,000 chars), `work` (subagent reports). Thoughts are never logged.
- **Tree**: each message becomes a ≤ 512-byte line (short ones stay verbatim); adjacent lines merge in pairs, again and again. Each node is built once.
- **View**: a list of nodes covering the whole chat, 64–128 KB. It grows one line per message and, past 128 KB, merges the most-due sibling pairs down to 64 KB in one batch: `due = (T − last message of the pair) / 2^level`. This is Taelin's rollback-netcode `push` (a binary counter) generalized to any budget, so old lines almost never change and the prompt cache holds. Between batches the view only grows at its end.
- **Turn**: `[system][view][previous exchange][time · cwd][your message]`, fresh every time. The model zooms when a line is too vague; `search` finds exact names in the original messages.
- **Compactor**: a cheap model, 8 calls in parallel, with a 16–32 KB context view of its own. Size is enforced by the harness (token cap + cut at the last separator), so it works with models that cannot count bytes or ignore "too long, rewrite".
- **Long turns** rebuild their context from memory instead of overflowing.

Details and the list of deliberate deviations from the recipe: [`docs/recipe.md`](docs/recipe.md). Design notes: [`docs/DESIGN.md`](docs/DESIGN.md).

## Cost

Roughly one compactor call per logged message over 512 bytes, plus one merge per message amortized (merges of two short lines are free). A free or cheap model (DeepSeek/Qwen flash tiers, Haiku) makes this negligible; `/mem status` shows calls, tokens and estimated cost for the session.

## Development

```sh
git clone https://github.com/catoncat/pi-endless && cd pi-endless
npm ci --ignore-scripts
npm run check              # types
bun test                   # view math, persistence, cutting, retries
node scripts/check-recipe.mjs   # has the upstream recipe changed since the pinned revision?
pi install .               # try it
```

## Credits

- Victor Taelin — the recipe ([gist](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)) and [OptMem](https://github.com/VictorTaelin/OptMem).
- [jonaslsaa/pi-optchat](https://github.com/jonaslsaa/pi-optchat) — an earlier pi implementation of the v1 recipe, useful prior art.

MIT.

---

## 中文

**给 pi 的一条永不结束的对话。** 打开一个有名字的对话，聊几个月，合上电脑，再回来：agent 什么都记得。没有 compaction，什么都不丢，上下文恒定大小。

实现的是 Victor Taelin 的 [OptChat / UniiChat 配方](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)：聊天本身就是记忆。每条消息逐字记日志；后台用便宜模型把日志压成二叉摘要树；每轮模型看到整段历史的一个**视图**（新的细、老的粗），需要时 **zoom** 回原文。

**默认不开。** 不打开对话时，pi 就是 pi。

```sh
pi install git:github.com/catoncat/pi-endless
pi --mem main        # 打开（或新建）对话 main；会话里也可 /mem open main
```

| 命令 | 作用 |
|---|---|
| `/mem` | 看状态（没开时弹选择器） |
| `/mem open <名字>` | 新会话里打开/新建；`<Tab>` 补全 |
| `/mem close` | 回到普通 pi |
| `/mem rename <新名>` | 改名，旧名留指针 |
| `/mem view` · `/mem zoom 1024+256` · `/mem search 词` | 自己翻记忆 |
| `/mem model` | 选压缩模型（新对话也默认用它） |
| `/mem list` | 所有对话 |

同一对话同一时刻只有一个 pi 在写；第二个 pi 打开时可选**只读**（能查不写）或**接管**。数据在 `~/.pi/memory/<名字>/`，纯文本文件。界面语言跟随 `LANG`，或 `MEM_LANG=zh`。

与配方的差异和原因见 [`docs/recipe.md`](docs/recipe.md)；设计见 [`docs/DESIGN.md`](docs/DESIGN.md)。
