# pi-endless 设计 — 一条永不结束、什么都不丢的聊天

状态：tracer bullet 跑通（2026-10-08）。配方：Taelin 的 OptChat/UniiChat gist v2（2026-10-08 版，`node scripts/check-recipe.mjs` 可取任一版本）。研究与取舍：`~/.pi/optchat-research.md`。

## 一句话

每轮模型只看到一个 64–128KB 的**视图**（整段历史的一行行摘要，老的粗新的细）+ 上一轮原文 + 新消息；一切逐字进日志，后台便宜模型把日志压成二叉摘要树；模型用 `zoom/search/date` 回到原文。没有 compaction，没有丢失，上下文恒定。

## 用户看到什么

| 做什么 | 看到什么 |
|---|---|
| `pi --mem main`（或 `/mem open main`） | 新会话绑定这个对话；状态栏 `mem main · 1234 msgs`；聊天记录里一张卡片：上次你说的 + 它答的、消息数、压缩器，ctrl+o 展开视图最新 12 行 |
| 正常聊 | 和普通 pi 一样；模型多了 `zoom / date / search`；每轮开头若上一轮摘要没建完，最多等 8 s，然后用占位行继续 |
| `/mem`（单独）| 开着→状态（含本会话压缩调用数/费用）；没开→选择器 |
| `/mem view / zoom id+n / search 词` | 在编辑器里看整个视图、展开一行、搜原文 |
| `/mem model` | 换压缩模型，新对话也默认用它；首次默认从已登录模型里挑最便宜的 haiku/flash/mini 类 |
| `/mem rename <新名>` | 改名，旧名留指针文件 `{renamedTo}`，旧会话绑定和 `--mem 旧名` 都跟过来 |
| `/mem close` | 关掉，回普通 pi |
| 另一个 pi 再开同一本 | 提示在哪用着：只读打开 / 接管（那边下一次写时降为只读）/ 取消 |
| 默认不开 | 其他会话（herdr 面板、子代理）一点不变 |

## 文件

```
~/.pi/memory/<name>/          （PI_MEM_HOME 可改；不在 pi-config 仓库里）
  main/YYYY-MM-DD.jsonl       每条消息 {i, kind, text, size, date}，只追加、fsync
  tree/YYYY-MM-DD.jsonl       树节点 {l, i, text, size}，每个只建一次
  view.json                   主视图 + 压缩视图（重启不重建，缓存前缀才稳）
  config.json                 {compactor: {provider, model, thinking?, maxTokens?}}
  lock.json                   {pid, token, session, cwd, at}
```

kind：`user` / `pi`（回复）/ `tool`（调用）/ `echo`（结果，截头尾 30k 字符）/ `work`（custom 消息：子代理报告、进程通知）/ `note`。思考永不记。

## 核心（core.ts，纯逻辑，bun test）

- 树：`node(0,i)` = 消息 i ≤512B 一行（本来就短的原样）；`node(l,i)` = 两个子行合成一行（两行拼起来 ≤512B 就直接拼，免费）。
- 视图：追加一行/消息；超 128KB **一次**合并到 ≤64KB；最该合并的兄弟对 = `(T - 这对最后一条消息号)/2^l` 最大者，相同取最老；只合父节点已建的对。测试证明它与 Taelin 的 rollback push 逐步一致，且两次批量之间视图只在尾部增长（每条消息平均重写 <3 行）。
- 压缩视图：同一算法，16–32KB，作为压缩器的 `<chat>` 上下文，到第一条未建的行为止。
- 调度：8 路并发；叶子优先（前面未建叶子 <8 个才开工），合并按层从低到高；失败 10 s 后重试，不指数退避；关闭时给在途调用 15 s 收尾。
- **尺寸由 harness 硬保证**（偏离配方）：`max_tokens≈170` + 在最后一个 `; `/句号处截到 ≤512B，提示词说"最有价值的先写，尾部可能被截"。原因：DeepSeek/minimax 等不听"太长了重写"的指令（5 次返回一模一样），Haiku 要开思考才听（1.8 次/节点、$0.03/节点）；截断法任何模型一次调用。

## pi 集成（index.ts）

- `before_agent_start`：`customPrompt` = 配方 v2 提示词（Unii→Pi；加 search；中文字节提示）；pi 的 AGENTS.md/skills/cwd 段照旧。
- `context`：第一次调用先定视图（等摘要 ≤8 s），再把本轮消息写日志；发给模型 `[视图][<previous_exchange>][<turn> now·cwd][新消息] + 本轮后续消息`。视图整轮不变（轮内缓存）。
- `message_end`：逐条进 run，视图定了之后随到随记；`agent_settled` 收尾。
- `session_before_compact` 取消、`cache_warming_decision` stop。
- Anthropic：视图按 4 行一块，倒数第二块打 `cache_control`，去掉 pi 在消息上的标记（4 个上限），请求末自动标记。经 PH 代理实测第二轮 cacheRead 30,956 / 新写 323。
- 工具 `exposure: codemode`，打开对话时 `setActiveTools` 加入，关掉时移除：不开对话的会话里模型看不到它们。
- `before_agent_start` 用 `customPrompt` 换开头；若更早的扩展返回了 `systemPrompt`（整段钉死），把它文本里的默认开头替换成我们的并提示一次。
- 卡片是 custom entry（`registerEntryRenderer`），不进模型上下文。界面文案 `t("en","zh")` 跟随 LANG。
- 锁：写之前核对 `lock.json` 里的 token；被接管就降只读并提示。

## 刻意不做

子代理（用 pi-subagents，报告自然进日志）、导入历史、连接窗口、检查器 UI、profile 选择器、用量账本、按目录自动绑定、多会话同写（以后守护进程）。

## 已知边界

- 压缩器与 turn 不共用 system prompt（配方要共用以吃同一份缓存）；压缩走自己的 `PROMPT`，无工具。
- 单轮太长：不撞 pi 的 compaction，`context` 里按 run 字节估算（≥ max(150KB, 2×contextWindow)）就从记忆重建上下文接着干——本轮已做的事已在日志和视图末尾，模型可 zoom。
- 压缩器挂了：视图里是占位行，`/mem status` 看错误；10 s 一次重试。
- 图片只记 `[image]`。

## 验证

- `bun test`：push 等价（t=0..3000）、锯齿缓存稳定、延迟合并、cutLine、建树/重启视图逐字节相同、重试、settle。
- print 模式：跨启动记住"蓝鲸/5433"；读 20KB 文件后下一次启动用 `search`+`zoom(6,1)` 找回 "v0.7.2"；撞锁退化为普通 pi；Haiku 经 PH 缓存命中。
