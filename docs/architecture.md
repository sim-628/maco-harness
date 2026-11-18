# 架构与运行边界

本仓库把邮件助理部署在 Cloudflare Worker 与每用户 Durable Object（DO）中。
客户端直接连接 Worker；DO 调用模型、Gmail 或 Microsoft Graph，再把持久事件和结果同步给客户端。
Supabase 负责登录身份，Worker 校验 JWT；邮件、模型和记忆数据不经 Supabase 中转。
无需沙盒、容器、独立 Agent 服务器、消息队列或向量数据库。

## 1. 分层与依赖方向

入口层 `worker.mjs`、`auth.mjs`、`http.mjs` 负责身份、Origin、请求大小和 WebSocket；用户身份只能来自验证后的 JWT。
应用层 `service.mjs` 组合任务、邮件、索引、记忆和连接，负责把客户端意图转成领域操作。
执行层 `harness.mjs` 管理模型循环，`mail-executor.mjs` 管理副作用，`scheduler.mjs` 统一安排可运行工作。
适配层 `model/` 与 `mail/` 处理供应商协议；`connections/` 管理凭据，`store.mjs` 管理 SQLite 事务、事件及幂等账本。
邮件索引、个人记忆和历史查询分别位于 `mail-index/`、`memory/`、`history/`；它们提供检索资料，不能扩大工具权限。`model/compaction.mjs` 管理持久摘要检查点，`model/context.mjs` 只负责有界上下文投影。

增加模型协议主要修改模型适配层；增加邮箱动作必须同时定义能力、OAuth scope、产品授权、请求冻结和测试。
不要让模型拼任意 HTTP 请求，也不要让客户端绕过命令账本直接执行本仓库管理的邮箱修改。

## 2. 用户 DO、Task 与模型上下文

**一个用户 DO 是数据与协调边界，一个 Task 是执行边界，一次模型请求是上下文边界。**
DO 保存该用户的连接、任务、事件、操作、索引和记忆；它不等于每用户常驻服务器或虚拟机。
多个 Task 可以并行，拥有各自的 runId、预算、消息和等待状态；同一 Task 可通过 steering 继续或调整目标。
恢复、重试和换设备不需要依赖模型供应商保存的长会话。

客户端可以展示一个个人助理时间线，用 taskId 关联独立目标及追问；统一时间线属于客户端呈现。
云端只把当前 Task 的有界历史、合法工具配对、最初目标、最新用户调整和相关记忆投影给模型。
上下文准备有界读取原始消息元数据，保留最初目标、最新用户调整和近期配对完整的工具交换；压力过高时先裁剪工具文本，再按需摘要较旧的记录。摘要存入独立 checkpoint 表，原始消息不变；超出每次处理预算的区间通过 coverage 和提示披露。输入预算采用保守 UTF-8 字节估算，不声称等于供应商实际 token 数。
长期连续使用靠持久历史与按需检索，不靠把全账户历史重复塞进每次请求。

按需读取的邮件正文或附件文本可能作为工具回执保留在该 Task 的消息账本中，审批预览也会保留撰写内容。
“索引只保存片段”只描述邮箱索引，不代表整个 DO 永不保存正文。生产保留期、任务回执脱敏与账户擦除需要单独落实。

## 3. 模型与凭据契约

Task 使用 `provider / model / effort / connectionId`；API key 在连接创建时提交，后续请求只引用连接。
现有预设为 OpenAI、Anthropic、DeepSeek；`openai-compatible` 接入兼容 Chat Completions 流式与工具调用的服务。
自定义 baseUrl 只存在连接侧，受 `MODEL_PROVIDER_HOSTS` 精确域名白名单控制，提示词和模型参数不能改写它。
仅允许受信 HTTPS endpoint，拒绝 IP、内网名称、凭据及歧义 URL，不跟随重定向；域名白名单不等于 DNS pinning。
effort 不受支持时发出明确 warning；未知 usage 保持 null。没有 ChatGPT / Claude 订阅额度 OAuth。

模型 key 与邮箱 token 通过 AES-GCM 加密，并绑定用户 vault、连接类别、供应商和连接 ID；公共接口不返回秘密。
邮箱 OAuth 使用 PKCE、一次性 state、服务商账户身份校验及刷新合并。
每个连接有 epoch：撤销、重连或权限变化使旧执行失效；续跑重新绑定当前连接，不能静默切换付款方。
OAuth scope 与产品 action grant 取交集，服务端在准备、批准和实际派发前复查。

## 4. 一个 alarm 的调度

每个 DO 默认最多同时运行 **2 个 Task、4 个邮件操作和 1 个维护步骤**。
Task 槽内 background 优先级最多占 1 个；它与维护槽不是同一概念。
邮件索引同步使用维护槽；可选模型偏好提取只在启动时没有运行中 Task 才进入维护槽。
等待审批、等待定时邮件和退避都会释放 Task 槽；同一邮件资源的写入依次执行。

所有持久唤醒归 `ExecutionHost` 管理。任务和维护模块提供 nextDue，不另设 Cron 或互相覆盖 alarm。
接受工作前登记 repair alarm；正常推进由即时 kick 驱动，未来任务睡眠至到期，空闲时停止持续唤醒。
运行中工作在重建 DO 时恢复；调度收尾期间的新 kick 也会立即补跑，不必等待修复闹钟。
默认限制 32 个未结束 Task、256 个待处理邮件操作；容量可配置，取消和处理既有审批仍可进行。

## 5. 邮箱副作用与恢复

App、Agent 和定时邮件统一经过 `mail.submit` 对应的命令账本；commandId 防止客户端重试重复受理。
准备阶段只读取服务商资料，冻结目标、撰写内容、附件字节摘要及版本条件，再产生可审核的操作。
外发、删除草稿、删除 Gmail 用户标签和移除 Outlook 草稿附件要求逐次审批；审批绑定版本和冻结内容。
既有 Gmail 草稿通过 `mail_list_drafts` 获取真实 draftId，它与 message ID 不可互相推导。

派发前记录 dispatching。明确成功写入回执、推进资源 revision，并使索引失效；App 同步这些结果。
超时、连接中断或运行时丢失可能意味着服务商已执行，此时记为 unknown，阻止同资源后续写入越过。
unknown 不自动重发，需人工核对并 reconcile；明确限流或只读预检临时失败才允许有限退避。
供应商已受理发信不等于收件人已收到；搜索没有结果也不能证明从未发送。

版本防护包含 Maco revision、服务商版本复查，以及适用请求的条件头。
Gmail 和 Graph 附件操作仍有最终读取到写入之间的外部竞态窗口，不承诺跨服务商原子事务。
普通邮件永久删除、文件夹删除和任意 HTTP 不在动作目录内。

## 6. 邮件索引与事实来源

服务商邮箱是邮件状态的事实来源；本地索引保存稳定 mail ID、原生 ID、元数据和正文片段，完整正文按需读取。
稳定 ID 在邮箱边界内解析为原生 ID；`mail_read` 的观察、索引投影和 revision 在同步事务内提交，拒绝晚到响应倒灌。
`mail.sync` 启用持久分页同步：Gmail 使用 history，Outlook 使用分文件夹 delta；过期游标重建基线。
默认初始回填起点是 90 天前，随后约每 5 分钟检查变化；这不是自动 TTL，按需读取也可记住更早邮件。
Outlook 首次 delta 仍可能枚举大量历史项目，保存窗口不等于远程枚举窗口。

`fulltext` 搜索默认走服务商；`metadata` 仅在索引完整、时间范围覆盖且足够新时使用本地 FTS，否则回退。
片段匹配提供候选，后续凭 ID 精准读取和执行；coverage 和分页持续暴露，局部无结果不推断全邮箱不存在。

## 7. 三层个人记忆

稳定事实由用户显式编辑，保存来源、版本与删除状态；不从邮件或模型猜测自动写入账户事实。
相关历史使用独立 HistoryService：自动召回少量同用户、同任务邮箱的相关片段；Agent 可调用 history_search 搜索其他任务或指定任务，再用 history_read 精读公开文本。模型无法指定用户身份或任意邮箱范围。
历史索引抽取用户 / 助理文本和允许的邮件元数据、ID、执行状态；排除 providerState、完整邮件工具正文 / 附件，以及历史查询工具的回显。FTS 与中文双字切分有持久回填游标、候选上限和覆盖提示；同一旧任务不会占据全部跨任务结果。尚未采用 embedding 语义检索。

长期偏好默认通过窄规则捕捉用户明确表达的语言、长度和语气偏好，不增加模型调用。
可选 `model_proposals` 只发送对应用户原文，要求可核对证据；提案经用户批准后才生效。
三层资料以有界 JSON 注入上下文，当前用户指令优先；资料不能授权收件人、修改连接、跳过审批或改变工具集。
删除记忆清除活动值并保留防自动恢复的 tombstone；取消的提取在拿到凭证后及提交前重新检查状态。history_read 的目标和邻居同样检查来源排除、启用水位和 epoch，不能用已知 ID 绕过搜索过滤。派生回答及历史工具回显带内部 epoch；失效后不重新索引，当前上下文会隐藏旧引用并重建摘要。原始聊天和真实邮件执行回执仍保留。

详情见 [历史检索与上下文](history-and-context.md)。这组工具在记忆启用时向模型开放，纯历史读取不获取邮箱 OAuth token，不增加外部服务跳转。

## 8. 成本约束与生产待办

成本控制来自有限并发、事件式唤醒、上下文裁剪、读工具并行、metadata 检索和按 ID 读取，而非常驻沙盒。
每轮运行最多 12 个正常模型步骤、32 个工具调用、15 次模型尝试；每次正常输出请求上限 2048 token，单次 Task 调度有 120 秒 deadline。摘要最多两次尝试 / run，共用尝试总额并预留一次正常回复；摘要本身无可执行工具、最多 1536 输出 token、20 秒。失败有持久记录和冷却，不在相同来源上无界重试付费。
CONTEXT_INPUT_BYTES 默认 65536，运营方可在 16384–131072 之间配置。它是保守输入估算预算，不代表模型窗口自动发现；不同模型容量仍须验收。原文和固定工具定义过大、无法安全容纳时明确失败。
可选偏好提取每用户每天最多 8 次尝试，队列最多 16 项；实际调用仍消耗所选模型连接的用量。
邮件候选每页最多 8 条；正文与附件有大小预算，已提供准备、首段文本、读写和回放计时供实际测量。

正式上线仍需完成真实 OAuth 应用与回调、供应商兼容性验收、邮箱发送测试、历史回填容量和生产 p50 / p95 测量。
还需落实客户端切流、密钥轮换与备份、整账户物理擦除、历史保留期限和故障运维；当前不具备通用 MCP 或 PDF / Office 解析。
测试与构建证明本地协议和运行时路径，不代替这些生产验收。接入参数见 [协议](protocol.md)，部署见 [Cloudflare](cloudflare-deploy.md)。

参考：[Durable Objects](https://developers.cloudflare.com/durable-objects/)、[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)、[Gmail 同步](https://developers.google.com/workspace/gmail/api/guides/sync)、[Graph message delta](https://learn.microsoft.com/en-us/graph/delta-query-messages)。
