# pi-endless 设计 — 一条永不结束、什么都不丢的聊天

状态：tracer bullet 跑通（2026-10-08）。配方：Taelin 的 OptChat/UniiChat gist v2（2026-10-08 版，原文逐字存于 `docs/upstream/optchat.md`，`node scripts/check-recipe.mjs` 校验同步）。研究与取舍：`~/.pi/optchat-research.md`。

## 一句话

每轮模型只看到一个 64–128KB 的**视图**（整段历史的一行行摘要，老的粗新的细）+ 上一轮原文 + 新消息；一切逐字进日志，后台便宜模型把日志压成二叉摘要树；模型用 `zoom/search/date` 回到原文。没有 compaction，没有丢失，上下文恒定。

## 用户看到什么

| 做什么 | 看到什么 |
|---|---|
| `pi --mem main`（或 `/mem open main`） | 新会话绑定这个对话；状态栏 `mem main · 1234 msgs`；聊天记录里一张卡片：上次你说的 + 它答的、消息数，ctrl+o 展开视图最新 12 行 |
| 正常聊 | 和普通 pi 一样；模型多了 `zoom / date / search`；每轮开头若上一轮摘要没建完，最多等 8 s，然后用占位行继续 |
| `/mem`（单独）| 开着→全景图（下节）；没开→选择器。`/mem status` 是文字状态（含本会话压缩调用数/费用） |
| `/mem view / zoom id+n / search 词` | 在编辑器里看整个视图、展开一行、搜原文 |
| `/mem model` | 换压缩模型（全部已登录模型，打字模糊搜索，当前的排第一、便宜的按价格在前），新对话也默认用它；首次默认从已登录模型里挑最便宜的 haiku/flash/mini 类 |
| `/mem rename <新名>` | 改名，旧名留指针文件 `{renamedTo}`，旧会话绑定和 `--mem 旧名` 都跟过来 |
| `/mem close` | 关掉，回普通 pi |
| 另一个窗口再开同一本 | 什么都不问。在哪个窗口说话对话就跟到哪：新的一轮先读进别的窗口写的；那边正在回答就显示"正在另一个窗口里回答，等它答完就开始…"。那边每答完一轮，闲着的窗口自动插一张卡片「另一个窗口里聊了 N 轮」（每轮的原话和最后回答；不同目录才写目录），屏幕上的历史和记忆对得上 |
| 默认不开 | 其他会话（herdr 面板、子代理）一点不变 |

## 文件

```
~/.pi/memory/<name>/          （PI_MEM_HOME 可改；不在 pi-config 仓库里）
  main/YYYY-MM-DD.jsonl       每条消息 {i, kind, text, size, date}，只追加、fsync
  tree/YYYY-MM-DD.jsonl       树节点 {l, i, text, size}，每个只建一次
  view.json                   主视图 + 压缩视图（重启不重建，缓存前缀才稳）
  config.json                 {compactor: {provider, model, thinking?, maxTokens?}}
  lock.json                   {pid, token, session, cwd, at, busy, beat}
```

kind：`user` / `pi`（回复）/ `tool`（调用）/ `echo`（结果，截头尾 30k 字符）/ `work`（custom 消息：子代理报告、进程通知）/ `note`。思考永不记。

## 核心（core.ts，纯逻辑，bun test）

- 树：`node(0,i)` = 消息 i ≤512B 一行（本来就短的原样）；`node(l,i)` = 两个子行合成一行（两行拼起来 ≤512B 就直接拼，免费）。
- 视图：追加一行/消息；超 128KB **一次**合并到 ≤64KB；最该合并的兄弟对 = `(T - 这对最后一条消息号)/2^l` 最大者，相同取最老；只合父节点已建的对。测试证明它与 Taelin 的 rollback push 逐步一致，且两次批量之间视图只在尾部增长（每条消息平均重写 <3 行）。
- 压缩视图：同一算法，16–32KB，作为压缩器的 `<chat>` 上下文，到第一条未建的行为止。
- 调度：8 路并发；叶子优先（前面未建叶子 <8 个才开工），合并按层从低到高；失败 10 s 后重试，不指数退避；关闭时给在途调用 15 s 收尾。
- **尺寸由 harness 硬保证**（偏离配方）：`max_tokens≈170` + 在最后一个 `; `/句号处截到 ≤512B，提示词说"最有价值的先写，尾部可能被截"。原因：DeepSeek/minimax 等不听"太长了重写"的指令（5 次返回一模一样），Haiku 要开思考才听（1.8 次/节点、$0.03/节点）；截断法任何模型一次调用。例外：有的路由（实测 magpie 的 DeepSeek V4.1 Flash 走 clinepass）无视"不思考"偷偷推理且不返回推理，170 个 token 在写正文前就用完，得到空串或 "tool:" 这种残片；`length` 且正文 < 256 B 时当场多给 1024 token 重问一次，并记住这个模型此后都这么给（进程内）。

## pi 集成（index.ts）

- `before_agent_start`：`customPrompt` = 配方 v2 提示词（Unii→Pi；加 search；中文字节提示）；pi 的 AGENTS.md/skills/cwd 段照旧。
- `context`：第一次调用先定视图（等摘要 ≤8 s），再把本轮消息写日志；发给模型 `[视图][<previous_exchange>][<turn> now·cwd][新消息] + 本轮后续消息`。视图整轮不变（轮内缓存）。
- `message_end`：逐条进 run，视图定了之后随到随记；`agent_settled` 收尾。
- `session_before_compact` 静默取消（用户无事可做，不提示）、`cache_warming_decision` stop。
- 别的后台记忆扩展（pi-blackhole 及其前身 pi-vcc / pi-observational-memory）在打开的对话里待命：设它们文档里的 passive 环境变量。它们排在前面、在 session_start 里就懒读一次配置，所以必须在会话开始之前决定：启动时从命令行（`--mem`、`--session <文件或 id>`、`--continue`）读出要开的会话文件看有没有绑定；会话切换时在 `session_shutdown` 按目标决定（reload/fork 跟当前、`/mem open` 的 new 开、普通 new 关、resume 看目标文件）。我们设的值带 `PI_ENDLESS_STANDBY` 标记，子代理继承了也不会当成用户自己的设置。效果（rpc 和 herdr 面板实测）：O/P 仪表和 observer 消失，只剩如实反映单次请求大小的 X 仪表。缝：`--resume` 选择器选中的会话启动时无法预知，那一会话里 blackhole 照常跑，下次 /reload 起待命。
- Anthropic：视图按 4 行一块，倒数第二块打 `cache_control`，去掉 pi 在消息上的标记（4 个上限），请求末自动标记。经 PH 代理实测第二轮 cacheRead 30,956 / 新写 323。
- 工具是普通（direct）工具，打开对话时 `setActiveTools` 加入，关掉时移除：不开对话的会话里模型看不到它们；三个声明很小且逐字节稳定，不伤缓存，也不依赖 codemode。
- 写者轮换：同一时刻只有锁的持有者写。打开时若持有者正在一轮中（活着、`busy`、`beat` 3 分钟内），先以只读快照打开，否则直接拿锁。每轮第一次 `context`（`acquire`）：锁不是自己的就等持有者这一轮结束（轮询 0.5 s，Esc 可停），然后拿锁、`freeze()`+关掉旧副本、从磁盘重建 `Memory`（别的窗口写的日志、树、view.json 都读进来），`<previous_exchange>` 在这之后才算。一轮里每 60 s 心跳，`agent_settled` 时 `busy=false`。
- 别处的轮次上屏：每个窗口记 `seen`（已上屏的日志长度：自己的轮、开场卡片、补漏卡片）。空闲时每 2 s 读一次 lock.json：锁是别人的、不在一轮中、且 `token+beat` 变了（那边答完或刚打开）→ 关掉旧副本、只读重建 `Memory`、把 `seen` 之后的轮次追加成 `mem-elsewhere` 条目（不进模型上下文）。`acquire` 重建后同样补一次，兜住 2 s 内没赶上的那一轮。
- 关闭时 0 条消息的对话目录直接删（打错名字不留壳）；`/mem delete` 只移到 `.trash/`。
- `before_agent_start` 用 `customPrompt` 换开头；若更早的扩展返回了 `systemPrompt`（整段钉死），把它文本里的默认开头替换成我们的（不提示：那是别的扩展作者的事）。
- 卡片是 custom entry（`registerEntryRenderer`），不进模型上下文。界面文案 `t("en","zh")` 跟随 LANG。
- 丢锁即停笔：`Memory({owns})` 在每次写盘（日志、树节点、view.json）前核对 token，不是自己的就 `freeze()`，在途的摘要丢弃（新写者自己建）。空闲时被拿走不提示（下一轮自动拿回）；只有一轮中途被拿走（心跳停了 3 分钟以上）才提示这一轮剩下的没记上。`/mem delete`、`/mem rename` 遇到别的窗口开着就拒绝并说在哪。

## 全景图（map.ts，`/mem`）

用户打开它想做的事，按频率：**找**（"我们在哪聊过 X"）、**核对**（"它现在记得的是什么样"）、**看全貌**（多长、多细）。版面按这个排：

- 顶部：标题行（几条消息、自哪天、第几天）；两根同比例的柱，说过的全部 vs 每轮读的，后者灰=概括多条的行、绿=一条一行。
- 两行高的时间轴：横轴是全部消息，每格高度 = 覆盖它的那行有多细（`16-2l` 个八分之一格），同样灰/绿；下面一行标记：选中行覆盖的那段（括号），或搜索时每条命中的位置（刻度，选中的是 ▲）。
- `/` 搜索：边打边搜每条原话（不搜摘要；工具输出也搜，"那个报错在哪见过"），按天分组、关键词高亮，最新的在底。每条命中的预览写"pi 记得的样子"：原样在视图里 / 在视图里写成… / 在一行概括 N 条的句子里（附那行）。这一句回答"它为什么忘了细节"。
- 列表：视图的每一行，按天分组（日期头吸顶），新的在底；默认隐藏工具调用（`t` 切换），你/pi/工具/结果 标签，概括行标"N 条"；enter 展开成两半一路到原话，原话页同样先写"pi 记得的样子"。
- 页脚只在摘要排队或出错时说话。PageUp/Down 被 pi 拿去滚聊天记录，所以翻页是 `[ ]`。搜索框用 pi-tui 的 `Input`，焦点传进去，输入法候选框位置正确。
- 每行不超过给定宽度（`test/map.test.ts`，含搜索、中文输入、隐藏工具、打开命中），窄屏用短按键提示。

## 对外只读接口（api.ts / cli.ts，`pi-mem`）

给 pi 之外的任何消费方（别的 agent、脚本、MCP 客户端）读这些按主题长期养着的对话。一套能力三个入口：库 `src/api.ts`、CLI `pi-mem`、MCP `pi-mem mcp`（手写 stdio JSON-RPC，无依赖；`bun build` 成单文件 `dist/pi-mem.mjs`，Node ≥22 直接跑）。

- 能力：`list`（大小、首末时间、用户最后一句、在哪个窗口开着）、`search`（原话，不搜摘要，默认跨所有对话，新的在前）、`view`（模型每轮读的那份，默认最新 200 行，免得撑爆 MCP 客户端的输出上限）、`zoom`、`message`、`since`（某时刻或某条之后，给同步类消费方）。每条命中/消息都带 `held`：verbatim / summarized / inside（哪一行、概括几条）——和 `/mem` 里"pi 记得的样子"是同一个函数。
- 只读快照：`Memory({readOnly})`，不拿锁、不写盘（`test/api.test.ts` 比对目录前后），所以不会把对话从正在用的窗口抢走。
- 隐私：工具调用和工具输出默认不返回（它们装着文件内容和命令输出），`includeTools` / `--include-tools` 显式要才给；测试用一个假密钥确认任何读法都不漏。
- 实测：Claude Code 经 MCP（临时配置）自己 list → search ×3 → message ×2 → since，答出 mac 对话里卸载 app 的结论。
- 写入（外部往对话里记一笔）没做：设计是 `inbox.jsonl`，持有者下一轮收进日志，不碰"同一时刻一个写者"。

## 刻意不做

子代理（用 pi-subagents，报告自然进日志）、导入历史、连接窗口、profile 选择器、用量账本、按目录自动绑定、多会话同写（以后守护进程）。

## 已知边界

- 压缩器与 turn 不共用 system prompt（配方要共用以吃同一份缓存）；压缩走自己的 `PROMPT`，无工具。
- 单轮太长：不撞 pi 的 compaction，`context` 里按 run 文本字节估算（≥ max(150KB, 2×contextWindow)）就从记忆重建上下文接着干——本轮已做的事已在日志和视图末尾，模型可 zoom；重建说明只给模型看，不记日志。实测 12 次 cat 45KB 文件的单轮在 270KB 处重建一次后正常收尾。
- pi 把系统提示词也当 `system` 消息发 message_end：跳过，不进 run、不记日志、不算字节。
- 调试：`MEM_TRACE=<file>` 每个 hook 一行；`MEM_DEBUG=<file>` 存最后一次请求体。
- 压缩器挂了：视图里是占位行，`/mem status` 看错误；10 s 一次重试。
- 图片只记 `[image]`。

## 验证

- `bun test`：push 等价（t=0..3000）、锯齿缓存稳定、延迟合并、cutLine、建树/重启视图逐字节相同、重试、settle；整条请求的前缀稳定（`test/index.test.ts`：轮内每步拨钟后上一次是下一次的前缀、跨轮系统提示词/工具/旧视图不变、Anthropic 标记位置，修复前的代码上它是红的）；全景图任意宽度不超宽。
- `node scripts/cache-check.mjs <provider/model>`：真实服务商两轮多步，cacheRead 每步都涨、第二轮开头命中。2026-10-11 DeepSeek V4 Flash：21888→50048 逐步上涨，第二轮首步 21632。
- print 模式：跨启动记住"蓝鲸/5433"；读 20KB 文件后下一次启动用 `search`+`zoom(6,1)` 找回 "v0.7.2"；撞锁退化为普通 pi；Haiku 经 PH 缓存命中。
