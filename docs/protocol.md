# Maco 客户端协议 v1

除 `GET /health` 外，HTTP 请求均携带 `Authorization: Bearer <Supabase access token>`；JSON 请求使用 `Content-Type: application/json`。服务器从已验证 JWT 的 `sub` 定位用户 DO，不接受客户端指定其他用户。浏览器跨域需要部署 `ALLOWED_ORIGINS` 精确来源白名单。单个 JSON 请求上限 256 KiB。

## 1. 命令、版本和身份

持久修改统一发到 `POST /v1/commands`。每个命令包含 `protocolVersion: 1`、客户端先落盘的 `commandId` 与 `type`。相同 ID、相同负载重试返回原受理结果；相同 ID、不同负载返回冲突。HTTP 202 表示持久受理，不表示邮件已成功修改。

| 字段 | 所属对象与用途 |
| --- | --- |
| `connectionId` / `mailboxId` | 用户自己的模型 / 邮箱连接；不能跨用户引用 |
| `taskId` / `taskVersion` | 独立目标与当前版本，用于追问、改配置和取消 |
| `runId` | 一次固定模型配置、连接 epoch 与策略的运行 |
| `operationId` / `approvalVersion` | 云端邮箱操作及其冻结内容版本 |
| `expectedEpoch` | 修改或撤销连接时的乐观锁 |
| `mailMessageId` | Maco 索引分配的稳定邮件 ID；与 provider ID 和 RFC Message-ID 区分 |
| `draftId` | 服务商草稿 ID；Gmail 的 draft ID 与 message ID 不同 |
| `seq` | 该用户 DO 的持久事件序号，多端回放游标 |

## 2. 连接

| 接口 | 请求 / 行为 |
| --- | --- |
| `POST /v1/connections/model` | `{provider,apiKey}`；兼容服务商再传 `baseUrl`；替换时带 `id,expectedEpoch` |
| `POST /v1/connections/oauth/start` | `{provider:"gmail"或"outlook",actions:[...]}`；打开返回的 `authorizationUrl`；重新授权可传原 `id,expectedEpoch` |
| `POST /v1/connections/oauth/complete` | 已登录 App 或回调页提交 `{state,code}`；state 一次有效并绑定用户与 PKCE |
| `GET /v1/connections` | 返回元数据、实际 scopes、产品授权、status 与 epoch，不返回秘密 |
| `POST /v1/connections/actions` | `{id,expectedEpoch,actions}`；提高产品授权不等于自动获得 OAuth scope |
| `POST /v1/connections/revoke` | `{id,expectedEpoch}`；清除本地凭据并让旧 epoch 失效；邮箱索引一并清除 |
| `GET /v1/capabilities?connectionId=…&model=…` | 邮箱能力或模型协议与已知 effort；模型时传 model |

模型支持 `openai`、`anthropic`、`deepseek` 和 `openai-compatible`。兼容连接示例：

```json
{
  "provider": "openai-compatible",
  "apiKey": "USER_SUPPLIED_API_KEY",
  "baseUrl": "https://api.groq.com/openai/v1"
}
```

上例仅演示 endpoint 结构，不表示已验证该厂商所有模型。运营方必须把 `api.groq.com` 放进 `MODEL_PROVIDER_HOSTS`。只接受可信 HTTPS 主机和 API 根路径，拒绝 IP、内网 / localhost、凭据、query / hash、重定向及歧义路径；不要传完整 `/chat/completions`。白名单不是 DNS pinning。任务 profile 或提示词不能改 endpoint。兼容适配仅支持 Chat Completions streaming / tool calls，effort 仅保证 `provider-default`；其他 effort 会产生 `model_effort_unsupported` 警告。未返回 usage 时记为 null。

API key / baseUrl 更新使连接 epoch 增加，旧任务不能继续使用旧连接快照。本仓库没有 ChatGPT / Claude 订阅 OAuth。

**OAuth 回调由 App 或已部署的 HTTPS 回调页接收，再携带当前用户 token 调用 complete。** Worker 没有公开的 GET OAuth callback 页面，不能直接把 `/v1/connections/oauth/complete` 注册成浏览器回调。服务商 redirect URI 必须与 `OAUTH_REDIRECT_URI` 完全一致。撤销本地连接不保证自动撤销供应商账户中的远程 grant。

## 3. 任务与同一助理

```json
{
  "protocolVersion": 1,
  "commandId": "device-a-task-001",
  "type": "task.create",
  "message": "找出本周需要我回复的邮件，给我邮件出处。",
  "mailboxId": "MAIL_CONNECTION_ID",
  "timeZone": "Asia/Shanghai",
  "modelProfile": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "effort": "medium",
    "connectionId": "MODEL_CONNECTION_ID"
  }
}
```

响应包含 accepted、taskId、runId、taskVersion。示例模型名需与实际 API 账户可用模型核对。时区省略为 UTC。priority 可为 foreground / background。用 `task.steer` 传 `taskId,taskVersion,message` 和可选 `modelProfile` 创建新 Run；`task.cancel` 传 taskId 与当前 taskVersion。needs_review 任务需先核对外部操作。

UI 可以保持一个个人助理入口或统一聊天时间线；相关追问继续 Task，独立目标新建 Task。跨任务通过事实、偏好和相关历史延续，不需要把全部对话作为一个不断增长的模型 session。默认每用户最多 32 个未结束 Task，超过限额先结束 / 取消旧任务或调整容量配置。

## 4. 邮件索引与读取

启动或重新设置邮箱索引范围：

```json
{
  "protocolVersion": 1,
  "commandId": "device-a-index-001",
  "type": "mail.sync",
  "mailboxId": "MAIL_CONNECTION_ID",
  "after": "2026-08-20"
}
```

响应为 `{accepted:…,index:…}`，同步是持久后台分页任务。`GET /v1/mail/index?mailboxId=…` 查询同步状态和覆盖范围，不返回完整邮件表。连接邮箱不会自动启动全量索引；首次显式 mail.sync 的默认 after 为近 90 天，此后约每 5 分钟检查变化。Gmail 使用 history cursor，Outlook 使用分文件夹 delta；失效 cursor 重新建基线，期间不声称完整覆盖。没有 Gmail push / Graph webhook 订阅。Outlook 初次 delta 会枚举文件夹历史，再按时间窗口决定本地保存，不能把窗口等同于远程枚举量。

读取入口：

```json
{
  "mailboxId": "MAIL_CONNECTION_ID",
  "tool": "mail_search",
  "input": {
    "query": "发票",
    "scope": "metadata",
    "filters": {"after": "2026-10-01"},
    "limit": 8
  }
}
```

发到 `POST /v1/mail/read`。scope 默认 `fulltext`，走服务商搜索；只有 metadata 查询的时间范围已覆盖、基线完整、最近同步足够新（当前 2 分钟）且游标适合时使用本地索引，否则回退。返回 `matches,nextCursor,hasMore,coverage`。本地结果来自主题、地址、时间、标签等元数据及片段，不代表全文。服务商结果也不宣称已穷尽全部历史。查询支持 filters.from / after / before / unread / folderId；limit 为 1–8。

| 读工具 | 主要输入与结果 |
| --- | --- |
| `mail_search` | query、scope、filters、limit、cursor；游标原样回传 |
| `mail_read` | messageId；按 ID 读取，返回内容覆盖、revision、providerVersion |
| `mail_thread` | threadId；读取线程 |
| `mail_list_organization` | 列出该供应商的标签 / 文件夹 / 分类 |
| `mail_list_drafts` | limit 1–8、cursor；返回真实 draftId、邮件 citation、元数据 / snippet |
| `mail_list_attachments` | messageId；取得附件 ref |
| `mail_read_attachment` | 附件 ref；受限文本内容 |

索引分配 `mail_<UUID>` 稳定 ID，返回 `mailMessageId` 及规范 citation。操作仍可接收 provider message ID 以便兼容；RFC `Message-ID` 邮件头不能作为操作 ID。稳定 ID 绑定邮箱，不能跨邮箱使用。`draftId` 始终来自草稿接口，不能拿 `mailMessageId` 推断。完整正文按需读取，正文不写入索引片段列。索引变更使本地查询游标失效时，重新执行搜索。

`mail_list_drafts` 的游标是 opaque 字符串，客户端只回传。Gmail 使用真实 drafts.list / get；列表后已发送或删除的草稿可被跳过并计入 unavailable。Graph 读取 drafts 文件夹并检查 isDraft，不保证覆盖用户移动到其他文件夹的草稿。此列表不返回完整正文。

文本附件 MIME 为 text/plain、text/markdown、text/csv、application/json，最多 48 KiB。外发支持同邮箱原附件引用，最多 12 份、合计 512 KiB；二进制附件可转发，不表示模型能理解 PDF / Office / 图像内容。

## 5. 邮箱修改与审批

手动按钮、Agent、自动标记已读、批量操作和定时发送共用云端账本。每批 1–30 项，准备失败则整批不受理；受理后逐项执行及结算。已准备的请求合计另有 1.5 MB 上限。

```json
{
  "protocolVersion": 1,
  "commandId": "device-a-mail-001",
  "type": "mail.submit",
  "mailboxId": "MAIL_CONNECTION_ID",
  "items": [
    {"input": {"action": "mark_read", "messageId": "mail_STABLE_ID"}},
    {"input": {"action": "send", "to": ["recipient@example.com"], "subject": "会议纪要", "body": "请查收今天的纪要。"}}
  ]
}
```

### 动作并集

实际可执行动作以连接 capabilities 为准，必须同时满足产品授权与 OAuth scope。

| action | 主要参数 | 服务商 / 行为 |
| --- | --- | --- |
| mark_read / mark_unread、star / unstar | messageId | 两家，已读 / 旗标 |
| archive / trash / restore / move_to_inbox | messageId | 两家；Graph restore 可带 folderId，默认 inbox |
| mark_spam / mark_not_spam | messageId | Gmail SPAM / INBOX 标签，Graph junkemail / inbox 移动；不承诺训练过滤器或封禁发件人 |
| mark_important / mark_unimportant | messageId | Gmail IMPORTANT；Graph importance high / normal |
| add_label / remove_label | messageId、labelId | 仅 Gmail |
| create_label / rename_label | name；rename 再传 labelId | 仅 Gmail |
| delete_label | labelId | 仅 Gmail 用户标签，独立 grant、每次审批；从所有邮件移除该标签 |
| move | messageId、folderId | 仅 Outlook |
| create_folder / rename_folder | name；create 可有 parentId；rename 有 folderId | 仅 Outlook |
| set_categories | messageId、categories | 仅 Outlook，替换分类数组 |
| create_draft / update_draft | 完整撰写内容；update 有 draftId | 两家 |
| delete_draft | draftId | 两家；独立 grant、每次审批；确认为草稿后删除 |
| add_draft_attachment | draftId、ref | 仅 Outlook，引用原附件 |
| remove_draft_attachment | draftId、attachmentId | 仅 Outlook，write grant、每次审批 |
| send / reply / forward | to / cc / bcc、subject、body、bodyType、attachments；reply / forward 有 messageId | 各自 grant，全部逐次审批 |

`modify` 包含整理邮件及四个 spam / important 标志；不包含 delete_draft / delete_label。`write` 包含草稿与附件动作。`move_to_trash` 仅展开为 trash。Gmail modify scope 可以覆盖部分发送权限，但不会绕过产品 send grant 或实际内容审批；Graph Mail.ReadWrite 与 Mail.Send 分开处理。

响应 operations 包含 state、preview、approvalVersion。waiting_approval 时展示服务端冻结的实际收件人、主题、正文、附件名称 / SHA-256、动作含义及执行时间；HTML 当作不可信邮件内容渲染。用户确认后提交：

```json
{
  "protocolVersion": 1,
  "commandId": "device-b-approve-001",
  "type": "mail.approve",
  "operationId": "OPERATION_ID",
  "approvalVersion": 1
}
```

`mail.reject` 拒绝待批操作；修改内容须拒绝旧操作并重新提交 / 审批。`items[].scheduledAt` 为 Unix 毫秒，获批且到期才执行。派发前 `mail.cancel` 可取消，携带 operationId 与当前 approvalVersion。默认最多 256 个待处理操作，容量满时先处理已有队列。

`items[].expectedRevision` 是 Maco 资源版本；`expectedProviderVersion` 是邮件读取返回的 Gmail historyId 或 Graph changeKey。支持动作在准备与派发前复查。草稿相关动作还冻结 / 检查草稿状态与版本。Graph 适用的 PATCH / DELETE 使用条件版本；Gmail 的 GET→write、Graph 附件的父消息检查→attachment DELETE 仍有外部竞态窗口，不能宣称供应商提供统一原子版本锁。

succeeded 带服务商回执；发信 accepted 表示供应商已受理。明确限流或派发前临时读取失败最多退避两次；unknown 表示可能已发生副作用，不自动重发，并阻止同资源新命令越过。用 `GET /v1/operations/{id}` 获取回执。人工核对后可用 `mail.reconcile` 传 operationId、approvalVersion、outcome（succeeded / failed）和 evidence，保留原回执及核对结论。搜索无结果不足以认定未发送。

update_draft 使用完整的新撰写内容。Outlook 已有草稿追加附件使用独立动作，不能把附件塞进 update_draft。send 使用编辑器当前完整内容和原附件引用，原 provider 草稿保留。确认写入或出现 unknown 后会让索引失效并安排核对，不把本地预测当作供应商最终状态。

App 离线先持久保存原 commandId 与负载，联网后重试同一命令；不要另起原生 Gmail / Graph 直写路径。

## 6. 稳定事实、长期偏好和相关历史

`GET /v1/memory` 返回 settings、活动 memories 与 proposals；`?deleted=1` 包含 tombstone，limit 上限 200。当前最多 200 条活动记忆。新建事实：

```json
{
  "protocolVersion": 1,
  "commandId": "device-a-memory-001",
  "type": "memory.upsert",
  "key": "account.time_zone",
  "kind": "fact",
  "value": "Asia/Shanghai"
}
```

响应 `{accepted:…,memory:…}`。kind 可以是 fact / preference。已有 key 更新必须提供 `expectedVersion`；来源为用户显式编辑。记忆的时区值是模型上下文资料，任务调度时区仍以 task.timeZone 为准。不能以记忆授予权限、选择付款方 / 模型连接、跳过审批或覆盖系统及当前用户指令。

删除用 `memory.delete` 加 key、expectedVersion。删除后自动提取不能恢复同一 key；用户明确恢复需 `memory.upsert` 传 tombstone 的 expectedVersion 和 `restore:true`。手动编辑优先于自动提取。

默认 enabled=true、extractionMode=explicit。默认只从用户本人短句提取明确持久的语言、长短、语气偏好，例如“以后用中文回复，回答尽量简洁”。邮件 / 工具 / 助理内容不作为偏好证据，引用、多行、疑问或临时要求不进入这个自动路径。

开启后台模型提案：

```json
{
  "protocolVersion": 1,
  "commandId": "device-a-memory-config-001",
  "type": "memory.configure",
  "expectedVersion": 1,
  "enabled": true,
  "extractionMode": "model_proposals"
}
```

settings 初始 version 为 1，此后使用当前版本。配置响应 `{accepted:…,settings:…}`。model_proposals 从实际用户消息产生持久任务，固定当时连接 / 模型配置，仅发送相关用户文字，要求证据是原文精确子串。模型输出仅生成提案；用 `memory.proposal.approve` 或 `memory.proposal.reject` 携带 `proposalId,proposalVersion` 决定，批准才进入活动记忆。原始明确偏好路径仍可直接生效。关闭用 memory.configure 的 enabled=false。

后台提取最多 16 个排队任务、64 个待决提案、每 UTC 日 8 次模型尝试、每任务最多 2 次、单次 30 秒和最多 1000 输出 token；由维护调度器在没有前台模型工作时运行。使用原任务模型连接并记录 usage，不代表免费。

`GET /v1/memory/context?taskId=…&query=…` 返回 facts、preferences、relatedHistory 与 coverage。query 可省略，默认取当前 Task 最近用户消息。此同账号查看接口检索其他 Task；模型准备路径额外限定当前任务邮箱。来源包含用户 / 助理文字与允许的邮件元数据、执行回执投影，排除完整工具正文 / 附件、检索回显及私有 providerState。FTS 与中文双字实现关键词相关性，无 embedding。回填每次最多 256 条或约 1 MiB，持久保存游标；coverage.hasMore 表示尚未完成。

删除会清除活动值、证据和来源，保留 key tombstone，抑制其来源再次检索并取消旧提取。原聊天、过去事件和审计记录未物理删除；停用记忆不等于删除账户数据。账户擦除 / 历史期限另需产品实现。

### 6.1. 按需历史查询

记忆启用时，模型自动获得 `history_search` / `history_read`。App 可以通过下面两个只读 POST 接口使用相同服务，不需要 commandId。callerTaskId 必须是当前登录账号已有的 Task；服务端从该 Task 推出邮箱范围，不接收 userId 或任意邮箱授权参数。

`POST /v1/history/search`：

```json
{
  "callerTaskId": "current-task-id",
  "query": "Acme 报价",
  "after": "2026-11-01T00:00:00+08:00",
  "before": "2026-12-01T00:00:00+08:00"
}
```

替换示例中的任务 ID。after / before 可省略，分别包含下界 / 排除上界。可增加 taskId 搜索特定任务；省略则按其他任务聚合。工具查询是全部归一化词匹配，最多 16 个不同词；过宽返回 history_query_too_broad。新消息含 createdAt；旧消息没有时间戳时，不参与时间过滤。

响应 `{result:{results,coverage,capped,…}}`。每条结果包含 taskId、messageId、taskState、role、content、offset、offsetUnit、sourceChars、indexedChars、indexTruncated 等；最多 8 条。超过候选处理上限返回 coverage.candidateLimited，应缩小查询；有回填缺口或截断时，无结果不能证明原历史不存在。

`POST /v1/history/read`：

```json
{
  "callerTaskId": "current-task-id",
  "taskId": "matched-task-id",
  "messageId": "matched-message-id",
  "offset": 0,
  "neighbors": 1
}
```

响应 `{result:{taskId,messageId,role,content,offset,nextOffset,totalChars,neighbors,projection,projectionLimited,redacted,…}}`。nextOffset 非 null 时以它继续读取同一来源；单位为 Unicode code points。一次完整 JSON 至多 12000 UTF-8 字节。neighbors 取 0–2，每侧最多相应数量的短摘要。

用户 / 助理文本可读完公开投影，邮件工具只返回允许的元数据和执行回执。需要正文或当前状态时改用 mail_read 等邮件工具。精读和每个邻居检查同账号、邮箱、启用水位、来源排除和 epoch，猜测外部 ID 或读取已排除来源返回 history_source_not_found。

### 6.2. 上下文与摘要事件

Task 的 `context` 及 `attempt.started.context` 返回 estimatedBytes、checkpointVersion、coverage、warnings。coverage.complete 只描述本次任务上下文的记录覆盖；工具裁剪由 warnings 单独标记，不保证语义上保留所有细节。

`context.compaction_started`、`context.compaction_finished`、`context.compaction_failed` 通过原事件流同步摘要进度与费用信息。摘要最多两次尝试 / run，使用原模型连接；没有新 API key，也不向摘要请求开放工具。后台偏好提取和任务压缩是不同事件及预算。

关闭或删除记忆会使旧 epoch 的历史引用和摘要失效。历史原始聊天仍可在任务页面查看；已执行邮件操作的账本回执继续有效，不能因重新生成上下文而重复派发。详细覆盖与费用边界见 [历史检索与上下文](history-and-context.md)。

## 7. 多端快照、事件与恢复

新设备先 `GET /v1/snapshot`，保存 snapshotCursor 与投影。近期记录不足时按 nextTaskBefore / nextOperationBefore / nextPendingBefore 分页读取 `/v1/tasks`、`/v1/operations`、`/v1/pending`；活动任务用 `/v1/tasks?active=1&before=…`。详情为 `/v1/tasks/{id}?before=…`、`/v1/operations/{id}`。

1. `GET /v1/events?after=<seq>` 返回 events、committedCursor、hasMore；将事件和最后应用的 seq 放在同一本地事务。
2. `GET /v1/socket?after=<seq>` 升级 WebSocket。原生端带 Bearer header；浏览器用子协议 `["maco.v1","bearer."+accessToken]`，服务端只回选 maco.v1。
3. 只应用连续 seq，重复跳过，缺号通过 HTTP 补齐；回传 `{"type":"ack","seq":42}`。积压超过 128 条或 token 到期时重新连接，使用最新 token 与本地 cursor。
4. attempt.started 分配 messageId，message.delta 追加，message.committed 替换临时内容，attempt.abandoned 撤下中断输出。task.updated、mail.updated、mail.observed、connection.updated、memory 及 context.compaction_* 事件更新投影。关闭设备不取消云端任务。

`GET /v1/metrics` 返回当前用户最近约 4096 条计时样本的 count、p50Ms、p95Ms；覆盖受理、模型前准备、首段可见文本、邮箱读写、history_tool、广播与回放。正常模型及摘要 usage 分别按尝试记录，缺失为 null。设备展示延迟、真实供应商计费与生产性能仍需实测。

## 8. Swift 接入

```sh
swiftc -swift-version 6 -parse-as-library examples/MacoClient.swift -o /tmp/maco-client
export MACO_URL=http://localhost:8787
# MACO_TOKEN 由 App 登录流程提供
/tmp/maco-client snapshot
/tmp/maco-client command task.json
/tmp/maco-client watch 0
```

保存并修改上方 Task JSON，替换实际连接和模型。原生 App 将事件回调接到自己的数据库与 UI，并在登录到期时刷新 token。这个示例不是已经改造完成的 maco-mail 客户端。旧运行、待批发送和设备离线队列的唯一执行归属见 [迁移文档](migration.md)。
