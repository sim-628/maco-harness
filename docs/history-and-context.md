# 历史检索与长任务上下文

Maco 把个人事实、历史查询和当前任务上下文分成独立模块。设计参考 DeepSeek Harness 的 session-query / tool-session-query / compaction-basic，在 Cloudflare 用户 Durable Object 的 SQLite 中实现。

用户在一个助理界面中使用多个 Task；每次模型请求只携带当前工作所需的内容。跨任务资料通过少量自动召回和按需搜索取得。所有邮箱写操作仍由既有命令账本执行。

## 1. 模块与事实来源

| 模块 | 职责 | 持久数据 |
| --- | --- | --- |
| `Store` | 原始消息、任务、操作和事件 | `messages`、`tasks`、`operations`、`events` |
| `HistoryService` | 历史全文检索、来源校验、分段精读 | 可重建的 `memory_history` / FTS 索引 |
| `MemoryService` | 稳定事实、长期偏好、提案和遗忘设置 | `personal_memory`、设置、提案及后台任务 |
| `CompactionService` | 持久摘要、来源边界、费用和失败恢复 | `task_context_checkpoints`、`task_context_attempts` |
| `projectContext` | 组装有界模型请求，报告裁剪与缺口 | 无独立历史副本 |

原始消息不会因摘要、检索或模型窗口不足而被覆盖。摘要只改变模型下一次看到的投影。邮件当前状态仍以 Gmail / Microsoft Graph 为依据；历史回执只能证明当时已记录的结果。

## 2. 两条历史读取路径

### 自动召回

每次准备模型请求时，从最新用户消息抽取少量关键词，执行本地检索。自动召回使用 OR 匹配，排除当前 Task，并按任务聚合，最多四条相关片段。模型路径同时约束为当前任务绑定的邮箱。

事实、偏好与相关历史共享 6000 UTF-8 字节预算；为历史最多预留 35% / 2000 字节，未使用的空间可以供事实和偏好使用。自动召回无额外模型调用，但会增加少量提示内容。

### Agent 按需搜索和精读

记忆启用时，模型获得两个固定只读工具：

| 工具 | 输入 | 返回 |
| --- | --- | --- |
| `history_search` | `query`，可选 `taskId`、`after`、`before` | 最多 8 条带 task/message ID 的命中附近片段、任务状态、覆盖信息 |
| `history_read` | `taskId`、`messageId`，可选 `offset`、`neighbors` | 指定公开文本的一段、后续 offset、少量相邻消息摘要 |

不传 taskId 时搜索其他任务，每个任务只取一个最佳消息；传 taskId 时搜索指定任务，可检查当前任务中本次模型请求之前的记录。调用前固定的序号截止值由 Harness 写入 pending 状态，恢复后继续沿用。

模型可以先用公司或联系人关键词找到旧任务，再在任务内部搜索决定，最后按 ID 精读。搜索和精读不调用模型、embedding 服务或邮箱 OAuth；模型决定使用工具和消化结果仍然可能增加推理往返。

## 3. 检索、输出和覆盖约束

FTS 使用同一用户 DO 的 SQLite 索引，采用 BM25 排序和中文双字切分。模型工具查询要求全部归一化词命中；超过 16 个不同查询词返回 `history_query_too_broad`，应缩小查询。FTS 运算符作为输入数据转义，模型不能提交 SQL。

跨任务聚合前最多保留 129 条候选，超过预算通过 `coverage.candidateLimited` / `capped` 披露；不能据此断言不存在其他结果。搜索工具不给模型不受约束的返回数量参数。

每条来源最多索引 64 KiB 公开文本。命中结果给出 `indexTruncated`、`sourceChars`、`indexedChars`；超出索引前缀的内容不能保证搜到。搜索片段最多 480 个 Unicode 字符，围绕命中位置生成。无 embedding 语义同义词扩展或自动指代消解。

`after` 是包含下界，`before` 是排除上界，均须带时区的 ISO 8601。时间来自消息创建时间。旧版本没有 createdAt 的消息仍可搜索，但设时间过滤时不会匹配这些未知时间来源。

`history_read` 的 offset / nextOffset 单位是 Unicode code points，不是 UTF-8 字节或 JavaScript UTF-16 code units。每次完整 JSON 返回最多 12000 UTF-8 字节、正文片段最多 6000 字符。nextOffset 为 null 才表示公开投影已读完。neighbors 为 0–2，最多读取前后各两条短摘要，每条重新检查权限。

全文索引回填一次最多读取 256 条消息或约 1 MiB 原始数据，持久保存水位。`coverage.hasMore=true` 表示回填尚未完成；重复查询继续推进。单条允许的较大源记录可以单独处理，不把整个用户历史加载进内存。

## 4. 什么内容能跨任务读取

用户和助手的文本可以按 ID 分段读完公开投影。已知粘贴凭据形式会脱敏，但这不等于通用秘密识别器。

邮件工具只索引和返回白名单的元数据、目标 ID、操作状态与回执。完整邮件正文、附件正文、原始供应商 payload 不进入这条跨任务工具输出。需要完整或最新邮件时，凭邮件 ID 调用邮件读取工具。

providerState、模型私有续接块、未知内部字段以及 history_search / history_read 自身的工具回显不进入历史索引，避免递归复制召回结果。

`projection` / `projectionLimited` / `redacted` 描述精读返回的投影限制。对于邮件工具，nextOffset=null 只表示允许的元数据投影读完，不能当作原始邮件正文读完。

## 5. 用户隔离与记忆失效

JWT 验证后选择用户 DO。HistoryService 不接受模型传入 userId；Harness 从当前 Task 推出邮箱范围。HTTP 查询从 callerTaskId 推出相同范围，并检查该邮箱连接仍有效；无需获取或刷新邮箱 token。

检索、已知 ID 精读和邻近摘要共同检查启用状态、重新启用时的 historyFloor、来源排除表和派生内容 epoch。其他用户或不在当前邮箱范围的 ID 不可读取。

引用个人记忆、历史或相关摘要生成的助手消息带内部 historyEpoch。删除 / 配置变更后，旧派生回答退出历史检索；旧历史工具结果与相关助手正文在模型投影中替换为失效提示。摘要绑定 epoch，失效后重新准备。异步模型与摘要在提交前重新校验，旧输出不能触发新邮件动作。

真实邮件操作 ID、审批账本和已执行回执继续保留，避免因为遗忘历史而重复执行动作。原聊天 UI、审计事件、用户自己复制的文字并未物理擦除；账户擦除是独立生命周期功能。

## 6. 长任务压缩

正常短任务直接使用原文，不生成摘要。达到压力阈值后按以下顺序处理：

1. 先在模型投影中缩短较大的工具结果，保留头尾和明确标记，原始数据不变。
2. 仍超预算时，选择较旧且工具调用 / 结果完整配对的连续记录。
3. 使用当前 Task 的模型连接，生成邮件任务摘要；此次请求没有可执行工具。
4. 摘要保留目标、用户纠正、联系人及邮件 ID、已执行动作与回执、未决状态和下一步，并与旧检查点合并。
5. 重新校验 run、来源尾序号、凭证和记忆 epoch，同步提交 checkpoint。
6. 后续请求使用摘要、原始目标、最新用户调整和近期原文；仍有缺口时明确披露。

摘要不是新的用户授权，不能改变邮箱权限、收件人、模型付款连接或审批状态。模型必须以实际账本区分待批、已受理、成功、失败和结果不明。

### 默认成本与恢复预算

| 项目 | 默认 / 限制 |
| --- | --- |
| 输入估算预算 | 65536；运营方 `CONTEXT_INPUT_BYTES` 可设 16384–131072 |
| 压缩压力阈值 | 输入估算预算的 80% |
| 近期保留预算 | 最多 12000 字节，随较小输入预算调整 |
| 摘要文本预算 | 最多 6000 字节，随较小输入预算调整 |
| 摘要输出请求 | 最多 1536 token，仍受摘要字节上限约束 |
| 摘要耗时 | 单次 20 秒，属于 Task 总 deadline |
| 摘要调用 | 每 run 最多两次尝试，共用 15 次模型总尝试预算，并预留一次正常请求 |
| 失败恢复 | 同一 run / head / cut 不静默重复付费；其他失败有 60 秒冷却约束 |

预算采用保守 UTF-8 估算，没有自动发现所有模型窗口，也不承诺与供应商 tokenizer 精确相等。切换模型仍使用当前配置预算；运营方应按所用模型验收，特别是小窗口模型。

每批最多观察 256 条元数据，SQL 消息 ID 查询按 99 个一批读取。一次 run 的两次摘要不能覆盖任意大的存量任务。未处理的旧区间仍保存，但可能暂不进入当前请求；coverage 和模型提示会明确说明。若原始用户输入、固定工具定义或不可拆分的交换无法安全放入预算，任务明确失败。

空摘要、截断输出、摘要工具调用、过大或没有实际缩短来源的摘要均不提交。普通摘要失败可继续使用带缺口提示的有界上下文；取消、steer 或来源失效直接放弃旧准备。持久 attempt 标记避免重建后对同一中断摘要重新付费。

## 7. App 接入与观测

现有 task.create / task.steer 无需新增模型参数。记忆启用时，Harness 自动提供历史工具并按压力准备上下文。

App 需要直接展示搜索结果时，可以调用 `/v1/history/search` 和 `/v1/history/read`，请求示例见 [客户端协议](protocol.md)。这些是只读请求，无需 commandId。

Task 的 `context` 和 `attempt.started.context` 返回 checkpointVersion、estimatedBytes、coverage、warnings，不包含摘要正文。`context.compaction_started` / `finished` / `failed` 通过原有事件流同步，记录来源区间、状态、时长和 usage。`history_tool` 计时进入 `/v1/metrics`。

示例 warnings：`context_tool_results_pruned`、`context_history_omitted`、`context_compaction_cooldown`。客户端可以展示覆盖提示，不能把省略或摘要失败误报为历史丢失。

## 8. 升级和借鉴范围

数据库升级只新增 checkpoint / attempt 表和历史索引元数据字段，复用现有 messages 和 FTS 表。旧索引逐批从原消息重建；没有迁移用户 DO namespace，不改 OAuth 或模型连接。

采用了 DeepSeek 的职责分层、派生索引、搜索后精读、原文与上下文分离、配对完整的压缩切点与检查点恢复。针对邮件产品采用两个常用工具、现有中文索引、用户及邮箱权限和受限公开投影；没有实现父子会话 trace 工具、额外的跨任务摘要卡片、向量检索或第三方记忆 MCP。

参考版本：DeepSeek Harness [`2e39e70496aa02986ca6a820c5d497e816b69d7e`](https://github.com/deepseek-ai/deepseek-harness/tree/2e39e70496aa02986ca6a820c5d497e816b69d7e)。对应源码：

- [session-query 服务](https://github.com/deepseek-ai/deepseek-harness/tree/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/session-query)
- [模型历史工具](https://github.com/deepseek-ai/deepseek-harness/tree/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/experimental/tool-session-query)
- [compaction-basic](https://github.com/deepseek-ai/deepseek-harness/tree/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/compaction/compaction-basic)
- [Cloudflare SQLite DO](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
