# Maco 客户端协议 v1（后端 v0.4）

所有 `/v1/*` 请求携带 `Authorization: Bearer <Supabase access token>`；JSON 请求使用 `Content-Type: application/json`。服务器从已验证 JWT 的 `sub` 定位用户 DO，不接受客户端指定其他用户。浏览器跨域需要部署 `ALLOWED_ORIGINS` 精确来源白名单。单个 JSON 请求上限 256 KiB；资产上传使用独立的二进制 PUT。`GET /health` 公开；`/webhooks/gmail`、`/webhooks/graph` 验证服务商通知，不能用普通 App token 代替其验证。

本协议不是旧 `/v1/chat` API 的兼容层。相同 Supabase 用户不会自动继承旧 Worker 的 Task、连接、消息 ID 或资产。`GET /v1/status` 返回版本、启用的功能、限制与账户状态；`/health` 只证明入口可达。

## 1. 命令、版本和身份

Task、邮箱操作、记忆、定时任务等命令发到 `POST /v1/commands`。每个命令包含 `protocolVersion: 1`、客户端先落盘的 `commandId` 与 `type`。相同 ID、相同负载重试返回原受理结果；相同 ID、不同负载返回冲突。HTTP 202 表示持久受理，不表示邮件已成功修改。连接授权、文件上传、通知注册和账户生命周期使用下文的独立 HTTP 接口，不包在 commands 中。错误响应为 `{error:"machine_code"}`，客户端按 code 和当前版本处理，不能把所有 409 当作可无条件重试。

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
| `conversationId` | UI 聊天分组，默认 `primary`；同一聊天可包含多个 Task |
| `assetId` / `executionId` | 私有文件与托管子任务；不是公开下载 URL |
| `interactionId` / `expectedVersion` | 等待用户输入的问题及回答版本；不代表操作审批 |
| `generation` | 账户生命周期水位；reset / delete 会使旧请求与导出游标失效 |

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
  "mailboxIds": ["MAIL_CONNECTION_ID"],
  "conversationId": "primary",
  "timeZone": "Asia/Shanghai",
  "modelProfile": {
    "provider": "anthropic",
    "model": "YOUR_AVAILABLE_MODEL",
    "effort": "medium",
    "connectionId": "MODEL_CONNECTION_ID"
  }
}
```

响应包含 accepted、taskId、runId、taskVersion。模型名需替换为实际 API 账户可用模型。时区省略为 UTC，priority 可为 foreground / background。`mailboxIds` 与 `connectorIds` 各最多 20 个；`assetIds` 新输入最多 4 个，全部可省略，支持纯聊天 / 文件 / MCP 任务。旧单值字段 `mailboxId` 仍接受，和数组同时提供时必须一致。多邮箱工具调用必须指定任务授权范围内的 mailboxId。

`readOnly:true` 移除邮箱写工具和需要审批 / 写入的 MCP 工具。`allowHosted:true` 仅在运营方已配置托管执行器时开放委派。Task 创建时固定资源范围与 epoch；后续 `task.steer` 传 `taskId,taskVersion,message` 和可选 `modelProfile` 创建新 Run，保留已有资源范围，不支持通过 steer 任意扩大连接或附件列表。`task.cancel` 传 taskId 与当前 taskVersion。needs_review 任务需先核对外部操作。

UI 可以保持一个个人助理入口或统一聊天时间线；相关追问继续 Task，独立目标新建 Task。跨任务通过事实、偏好和相关历史延续，不需要把全部对话作为一个不断增长的模型 session。默认每用户最多 32 个未结束 Task，超过限额先结束 / 取消旧任务或调整容量配置。

### 3.1. 时间线、交互与待办

`GET /v1/conversations` 列出聊天分组；`GET /v1/conversations/{conversationId}/messages?before=…` 返回跨 Task 的公开消息、taskId、nextBefore 与 snapshotCursor，每页最多 100 条。消息历史分页游标与事件 seq 不可混用；Task 详情仍从 `/v1/tasks/{id}` 取得。

模型调用 `ask_user` 后，Task 进入 waiting_user，释放模型槽。`GET /v1/interactions?waiting=1&before=…` 返回问题、fields 与 version。任一设备可发送 `interaction.respond` 命令，包含 `interactionId,expectedVersion,answer`；无字段问题的 answer 是字符串，有字段时是按 field.id 填写的对象。当前回答版本只能受理一次；任务已取消或换 Run 时旧问题不能再答。回答问题不会批准任何邮箱 / MCP 写操作。

`work_item.upsert` 命令包含 `id?,expectedVersion,title,detail?,state?,dueAt?,taskId?`；state 为 open / completed / cancelled，dueAt 为 Unix 毫秒。新建 expectedVersion 为 0，更新使用当前版本。`GET /v1/work-items?active=1&before=…` 返回分页记录。待办的 dueAt 只是一项数据，不会自动创建定时模型任务或发送邮件。

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

响应为 `{accepted:…,index:…}`，同步是持久后台分页任务。`GET /v1/mail/index?mailboxId=…` 查询同步状态和覆盖范围，不返回完整邮件表。连接邮箱不会自动启动全量索引；首次显式 mail.sync 的默认 after 为近 90 天，此后约每 5 分钟检查变化。Gmail 使用 history cursor，Outlook 使用分文件夹 delta；失效 cursor 重新建基线，期间不声称完整覆盖。配置通知后可注册 Gmail / Graph watch 提前唤醒同步，见第 12 节。Outlook 初次 delta 会枚举文件夹历史，再按时间窗口决定本地保存，不能把窗口等同于远程枚举量。

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

`mail_read_attachment` 直接读取 text/plain、text/markdown、text/csv、application/json，最多 48 KiB。更大或二进制文件导入 R2 后走资产解析（第 8 节）。外发支持同邮箱原附件引用或 `{assetId}`，最多 12 份、合计 512 KiB；允许转发二进制不表示已完整理解其内容。

### 4.1. App 邮件列表与端侧分析

| 接口 | 输入 / 结果 |
| --- | --- |
| `GET /v1/mail/messages` | mailboxId 必需；query、folderId、cursor、limit（1–50，默认 30）、after、before、unread=1 可选；返回元数据与 opaque cursor |
| `GET /v1/mail/folders` | mailboxId；可选 parentId、cursor、limit（默认 50） |
| `GET /v1/mail/aliases` | mailboxId；发送身份发现，当前不开放任意 send-as |
| `GET /v1/mail/configured-aliases` | `mailboxId`；返回 `{aliases:[{id,name,address}],aliasSync:{version,removed}}`，`removed` 为小写地址与删除 UUID 的映射 |
| `POST /v1/mail/configured-aliases` | `{mailboxId,aliases:[{id,name,address}],restoring?}`；按地址忽略大小写合并。重新添加已删除地址时，`restoring` 必须包含当前删除 UUID。每个邮箱最多 100 个 |
| `POST /v1/mail/configured-aliases/remove` | `{mailboxId,address,expectedAliasId?}`；删除 Maco 中配置的发件别名并阻止旧设备补传。传入当前别名 ID 可避免并发重加后误删。返回最新同步状态，服务商发送授权不受影响 |
| `POST /v1/mail/configured-aliases/edit` | `{mailboxId,previous:{id,name,address},alias:{id,name,address},restoring?}`；按原值校验并原子更新，保留别名 ID。地址变更会在 `aliasSync.moved` 中记录旧地址对应的别名 ID，同步时可保留草稿引用 |
| `GET /v1/mail/raw` | mailboxId、messageId；返回最多 10 MiB 原始 MIME 下载，不写入全文索引 |
| `GET /v1/mail/delta` | mailboxId、after、limit；本地索引增量与删除 tombstone，游标不是事件 seq |
| `POST /v1/mail/analysis` | `{mailboxId,messageIds}`，最多 100 个；返回 not_synced / not_analyzed / available / stale |

App 列表最多 50 项，Agent 搜索最多 8 项，避免把 UI 分页大小带入模型上下文。服务商分页游标原样回传；Graph cursor 中可能有 skip / skiptoken，不由 App 拼接。

设备生成的摘要和分类使用 `mail.analysis.sync` 命令：`{mailboxId,items:[{messageId,expectedVersion,providerVersion,summary,categories,analyzer}]}`，每批 1–50 项。邮件必须已进入索引，新记录 expectedVersion 为 0；providerVersion 来自邮件读取。服务端保存来源 on_device、版本和连接 epoch，旧版本 / 新服务商内容标为 stale。此接口不调用模型，也没有云端摘要或分类兜底。

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
| add_draft_attachment | draftId、ref | 仅 Outlook，引用原附件或 `{assetId}` |
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

update_draft 使用完整的新撰写内容。Outlook 已有草稿追加附件使用独立动作，不能把附件塞进 update_draft。send 使用编辑器当前完整内容和附件引用，原 provider 草稿保留。`attachments:[{assetId:"asset_UUID"}]` 可以引用上传或托管产物；每项只能使用资产引用或邮箱附件引用一种形式，不能混入任意 URL / base64。准备时检查拥有权、来源邮箱 epoch 并冻结名称、MIME、字节与 SHA-256；后续删除 / 撤销使未派发操作失效。确认写入或出现 unknown 后会让索引失效并安排核对，不把本地预测当作供应商最终状态。

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

`GET /v1/memory/context?taskId=…&query=…` 返回 facts、preferences、relatedHistory 与 coverage。query 可省略，默认取当前 Task 最近用户消息。此同账号查看接口检索其他 Task；模型准备路径额外限定当前任务的邮箱与连接范围。来源包含用户 / 助理文字与允许的邮件元数据、执行回执投影，排除完整工具正文 / 附件、检索回显及私有 providerState。FTS 与中文双字实现关键词相关性，无 embedding。回填每次最多 256 条或约 1 MiB，持久保存游标；coverage.hasMore 表示尚未完成。

删除会清除活动值、证据和来源，保留 key tombstone，抑制其来源再次检索并取消旧提取。原聊天、过去事件和审计记录未物理删除；停用记忆不等于删除账户数据。整账户重置 / 删除使用第 13 节的独立生命周期接口。

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
4. attempt.started 分配 messageId，message.delta 追加，message.committed 替换临时内容，attempt.abandoned 撤下中断输出。task.updated、mail.updated、mail.observed、connection.updated、memory、context.compaction_*，以及 interaction / work_item / schedule / asset / connector / execution / notification 事件更新对应投影。关闭设备不取消云端任务；显式会话撤销或账户生命周期变化会阻止旧授权继续执行。

`GET /v1/metrics` 返回当前用户最近约 4096 条计时样本的 count、p50Ms、p95Ms；覆盖受理、模型前准备、首段可见文本、邮箱读写、history_tool、广播与回放。正常模型及摘要 usage 分别按尝试记录，缺失为 null。设备展示延迟、真实供应商计费与生产性能仍需实测。

## 8. 私有资产与解析

资产始终属于已登录用户，HTTP 不返回 R2 key 或公共下载 URL。默认每文件 10 MiB、每用户 2048 个文件 / 256 MiB；新任务最多选择 4 个 assetId，工具导入与托管产物回收后最多保留 64 个引用。上传文件不自动授予其他用户、其他邮箱或外部执行器访问权限。

| 接口 / 命令 | 请求与结果 |
| --- | --- |
| `PUT /v1/assets?name=…&taskId=…` | 原始二进制 body；Content-Type 为真实 MIME；可选 X-Content-SHA256、Idempotency-Key；201 返回 `{asset}` |
| `POST /v1/mail/attachments/import` | `{mailboxId,messageId,attachmentId,expectedEpoch?,taskId?}`；检查邮箱授权 / epoch，导入 R2，201 返回 `{asset}` |
| `GET /v1/assets?taskId=…&before=…` | 文件元数据分页 |
| `GET /v1/assets/{assetId}` | 元数据、hash、parseStatus 与 coverage |
| `GET /v1/assets/{assetId}/download` | 权限检查后的二进制下载；强制 attachment，不在 Worker origin 执行 HTML / SVG |
| `asset.parse` 命令 | `assetId,parser?,purpose?,force?,allowRetryUnknown?`；持久受理后返回 job |
| `GET /v1/asset-parses/{parseId}` | 读取持久解析任务状态 |
| `GET /v1/assets/{assetId}/text?offset=…&page=…` | 读取解析文本；每次最多 48 KiB，返回 nextOffset 与覆盖信息 |
| `GET /v1/assets/{assetId}/search?query=…` | 在解析文本中作有界子串搜索；不是语义搜索 |
| `asset.delete` 命令 | `assetId`；立即使访问失效，R2 删除由持久清理任务完成 |

上传的 Idempotency-Key 在本账号内幂等；同 key 同内容返回原资产，冲突内容被拒绝。客户端不得用 JSON base64 上传绕过二进制限额。taskId 为可选归属；Task 创建时仍要显式选择 assetIds。邮箱导入到已存在 Task 时，mailboxId 必须在任务范围内。

parser 为 `auto / local / cloudflare / deepseek`。auto 对文本用本地解析，对支持的常见文档用 Cloudflare；独立 OCR 需部署端 key 和相应选择。PDF auto 优先 Cloudflare，即使配置了 ASSET_AUTO_OCR 也不保证扫描页被 OCR。Cloudflare 每次检查支持格式，不把图片描述作为精确 OCR。

解析状态为 queued / running / persisting / succeeded / failed / unknown / cancelled。结果缓存绑定内容 hash、解析器版本和 purpose；没有解析结果时，text / search 可能排队解析并返回 pending，而不是同步阻塞到解析完成。需要不同解析策略时显式提交 asset.parse。收费 OCR 的 unknown 不自动重发；核对后才显式 force + allowRetryUnknown，仍需通过服务端截止时间检查。

每次读取返回 coverage、warnings、pageCount 与 coverageMeaning。`complete` 的含义以 coverageMeaning 为准：本地文本可完整读取，OCR 只保证服务商报告的页完成状态；识别错误、漏表格或布局损失仍需核对。Cloudflare 非截断结果通常为 unverified。文本读取 offset / nextOffset 是 JavaScript UTF-16 字符串偏移，page 从 1 开始；和 history_read 的 Unicode code points 单位不同。

外发引用 `{assetId}` 再次检查来源与字节摘要，仍受合计 512 KiB / 12 份附件限制。删除文件不等于撤回已被供应商接受的邮件。

## 9. MCP 连接与工具操作

只允许运营方在 MCP_SERVERS 中固定的 serverId、endpoint 和工具策略。用户可绑定自己的 token 或 OAuth，不能通过提示词增加服务器或把邮件修改改走 MCP。具体运营配置见 [MCP 模块说明](../src/connectors/README.md)。

| 接口 | 请求 |
| --- | --- |
| `GET /v1/connectors` | 返回本用户连接元数据和可选服务器 |
| `POST /v1/connectors/token` | `{serverId,token,id?,expectedEpoch?}`；替换连接需当前 epoch |
| `POST /v1/connectors/oauth/start` | `{serverId,id?,expectedEpoch?}`，打开返回授权 URL |
| `POST /v1/connectors/oauth/complete` | 同一登录用户提交 `{state,code,iss?}` |
| `POST /v1/connectors/discover` | `{connectionId,expectedEpoch}`；获取并校验工具目录 |
| `GET /v1/connectors/tools?connectionId=…` | 返回已发现且获准的工具 |
| `POST /v1/connectors/revoke` | `{id,expectedEpoch}`；擦除本地秘密并撤销旧 epoch |
| `POST /v1/connectors/read` | `{connectionId,expectedEpoch,tool,arguments}`；仅允许无审批的只读工具 |
| `GET /v1/connectors/operations?before=…&pending=1` | 操作分页 |
| `GET /v1/connectors/operations/{operationId}` | 读取冻结参数、状态、approvalVersion 与回执 |

需要审批的调用使用 `connector.submit` 命令，含 connectionId、expectedEpoch、tool、arguments。服务端冻结参数、目录和 schema；用 `connector.approve / connector.reject` 携带 operationId、approvalVersion 决定。`connector.cancel` 取消未派发操作；`connector.reconcile` 再携带 outcome（succeeded / failed）与 evidence 核对 unknown。模型调用沿用同一账本，不另起写路径。

状态为 waiting_approval / queued / dispatching / succeeded / failed / unknown / rejected / cancelled。写工具必须审批；未知工具不开放，服务商 annotations 不授予权限，目录 / schema 变化使旧批准失效。重新构建时若 OAuth 旋转 refresh token 的结果不确定，要求重新授权，不重放旧 refresh token。撤销本地凭据不声称撤销发行方的所有远端 grant。

当前支持有界远程 HTTP MCP，默认协议 2026-07-28，并提供明确配置的旧 Streamable HTTP 版本；不提供 stdio、任意请求头、任意 URL、sampling、roots 或远程服务器主动扩大权限的路径。

## 10. 托管复杂子任务

托管执行器需要运营方启用、配置独立 OPENAI_AGENTS_API_KEY / HOSTED_AGENT_MODEL，且当前 Task 创建时设置 `allowHosted:true`。模型可以用受限 delegate_task 工具委派；没有对 App 开放任意 shell / 任意托管环境启动接口。

子任务只发送限定指令、选定文本和最多 4 个输入资产（每份 10 MiB、总计 40 MiB），不发送邮箱 / MCP 凭据或完整聊天历史。托管会话的网络、桌面和多 Agent 能力关闭。执行结果与最多 4 个产物（每份 10 MiB、总计 20 MiB）回收至用户私有 R2，回到原 Task；发信仍要求邮件操作批准。

| 接口 / 命令 | 行为 |
| --- | --- |
| `GET /v1/executions?taskId=…&before=…` | 查询该用户的托管执行 |
| `GET /v1/executions/{executionId}` | 当前状态、结果、产物、用量与清理进度 |
| `execution.cancel` 命令 | `executionId`；停止后续工作并持久执行远端 / 本地清理 |

父任务等待时释放普通模型槽。提交回执丢失会按执行标识核对远端会话，不盲目重复创建。取消、重置或删除后，外部未知结果可能使清理等待或 blocked；不能把“已请求取消”展示成“已确认远端删除”。费用由配置的运营方账户承担，与用户模型连接和 ChatGPT 订阅独立。

## 11. 定时任务、会话与用量

### 11.1. 只读周期任务

`GET /v1/schedules` 读取配置。`schedule.upsert` 命令示例：

```json
{
  "protocolVersion": 1,
  "commandId": "device-a-schedule-001",
  "type": "schedule.upsert",
  "expectedVersion": 0,
  "name": "每日待回复邮件",
  "message": "检查需要我回复的邮件，仅给出建议和出处。",
  "modelProfile": {
    "provider": "deepseek",
    "model": "YOUR_AVAILABLE_MODEL",
    "effort": "provider-default",
    "connectionId": "MODEL_CONNECTION_ID"
  },
  "mailboxIds": ["MAIL_CONNECTION_ID"],
  "connectorIds": [],
  "intervalMinutes": 1440,
  "maxRunsPerDay": 1,
  "timeZone": "Asia/Shanghai",
  "conversationId": "primary",
  "enabled": true
}
```

更新传 id 和当前 expectedVersion；可传 Unix 毫秒 nextAt，默认从现在起一个间隔。intervalMinutes 为 60–43200，maxRunsPerDay 为 1–24，每账户最多 32 个配置、每 UTC 日最多启动 24 次。timeZone 不改变 UTC 日预算；这是固定间隔调度，不是任意 Cron 表达式。

每次到期创建独立 background Task，强制 readOnly=true、allowHosted=false；没有邮件修改 / 外发或 MCP 写工具。创建 Task 与推进 nextAt 在同一事务中，停机错过的间隔不会集中补跑。模型 / 连接 epoch 或会话变化会停用配置；容量满暂缓。`schedule.cancel` 命令携带 id、expectedVersion 停用。周期建议与第 5 节经批准的 scheduledAt 邮件发送是两类能力。

### 11.2. 会话即时撤销

`GET /v1/sessions` 返回本账户见过的 sessions 和 currentSessionId。用 `session.revoke` 命令传 sessionId、expectedVersion 撤销指定会话；`session.revoke_all` 撤销全部并记录签发时间水位。App 应在丢弃登录 token 前调用撤销接口。

本地撤销会拒绝旧 HTTP / WebSocket，停止该授权创建的未派发工作；已经被外部 API 接受的副作用不能撤回。后台任务可跨 JWT 正常续期 / 到期继续，关闭设备不等于撤销。只在 Supabase 侧注销而不通知此 Worker，已有 JWT 在到期前仍可能通过离线签名校验；App 必须接入该协议，不声称每次请求都在线查询 Supabase 会话。

### 11.3. 用量

`GET /v1/usage?before=…` 返回分页记录与 nextBefore。每项包含 kind、provider、model、taskId、payer、state、usage、costUSD 和 billingComplete；Task 模型尝试、上下文压缩、偏好提取尝试与托管执行分别记录。模型切换不回写旧调用归属。

payer 为 user_connection 或 operator。供应商没有返回的 token 字段为 null，costUSD 为 null、billingComplete=false；不是 0，也不是完整费用账单。托管计算、OCR、存储与通知账单不由这个接口完整计算。UI 应展示“未知 / 待核对”，不要把 null 当成免费。

## 12. 通知、安装与邮箱 watch

通知接口是独立 HTTP，**不是 command 类型**：

| 接口 | 请求 / 结果 |
| --- | --- |
| `GET /v1/notifications` | 启用条件、安装、watch 状态及最近 50 条 delivery |
| `GET /v1/notifications/deliveries?before=…&limit=…` | 投递账本分页 |
| `POST /v1/notifications/installations/upsert` | `{installationId,token,expectedEpoch?}`；注册 / 更新 APNs token |
| `POST /v1/notifications/installations/revoke` | `{installationId,expectedEpoch}`；撤销安装 |
| `POST /v1/notifications/watch` | `{mailboxId,expectedEpoch}`；注册 / 续期持久邮箱 watch |
| `POST /v1/notifications/unwatch` | `{mailboxId,expectedVersion}`；停用当前 watch |

POST 返回 202 表示受理，查询状态确认后续结果。installationId 应由设备稳定保存；topic、环境与服务商配置由部署端决定。设备 token 不出现在状态响应中。通知是通用消息 / 输入提示或后台同步提示，不携带邮件正文、发件人或主题；收到后重新拉取服务端状态。

公开服务商入口只有 `POST /webhooks/gmail` 和 `POST /webhooks/graph`；Graph 的 POST validationToken 原样验证握手按服务商协议处理。Gmail 检查 Pub/Sub OIDC、预期 audience / 服务账号 / subscription；Graph 检查 subscription 与 clientState。App 不能调用 `/internal/notifications/ingest`，公开 Worker 不接受该路径。

watch / 安装状态与投递账本属于用户 DO；独立 NotificationRegistry 维护 webhook owner 路由和共享 APNs JWT 缓存。相同 email 不授予另一个账号权限。重复通知有界去重，APNs 至少一次投递；回执丢失可能重复，同一 apns-id / collapse 信息降低重复展示，不保证恰好一次。已被 APNs 接受的消息不能撤回。

unwatch 立即停用本地路由和续期，不调用 Gmail stop，也不删除已存在的远端 Graph subscription；远端 watch 到期前可能仍向旧 URL 回调，服务端会忽略无效所有权。旧 App / Worker 的 Graph 订阅需要交接或等待到期，不能假设新 Worker 会自动继承。真实 APNs HTTP/2 接受、设备投递及 Google / Microsoft webhook 链路是部署后验收项，详见[部署配置](cloudflare-deploy.md)。

## 13. 账户导出、重置与删除

这些接口独立于 commands。开始前由产品界面清楚展示操作范围，客户端先保存 requestId，重试同一个意图使用同一 ID。

| 接口 | 请求 / 行为 |
| --- | --- |
| `GET /v1/account/status` | generation、active / resetting / deleting / deleted、阶段、清理与 blocked 原因 |
| `GET /v1/account/export?cursor=…&limit=…` | 分页公开数据，默认 50 项；原样回传 nextCursor |
| `POST /v1/account/reset` | `{requestId,expectedGeneration,resetMemories?}`，202 返回状态 |
| `POST /v1/account/delete` | `{requestId,expectedGeneration}`，202 返回状态 |
| `POST /v1/account/retry` | `{operationId}`；解决原因后继续 blocked 清理 |

reset 清除聊天、Task、事件、用量、定时配置和资产，取消尚未执行工作；保留模型 / 邮箱 / MCP 连接与邮箱索引 / 设备分析，默认保留稳定事实和偏好，resetMemories=true 则清除它们。通知待投递工作被隔离，安装 / watch 配置保留。原聊天来源随重置失效。

delete 清理本后端的凭据、会话、索引、分析、记忆、资产及通知注册。**不会删除 Gmail / Outlook 邮件，不删除 Supabase 登录身份，也不自动处理原网站 / passkey / 旧 Worker 数据。** 删除后同一用户身份在此后端保留 deleted tombstone，不能把普通登录当成重新开户。

生命周期先持久递增 generation 并阻止新工作，再等待在途任务、R2 上传 / 解析、托管和通知清理完成。状态 / 清理接口在正常任务被隔离时仍可用。已有异步请求不能在重置后重新写回旧数据；未确认的外部结果会保留最小 uncertainty / 幂等墓碑，默认清理超时后 blocked，不能假报“全部删除”。

export 只导出有界公开投影，排除密钥、OAuth token、私有 providerState 和完整工具 payload；不包含资产原始字节，需在删除前另外下载。分页有初始行上界和 generation 检查，截断记录明确标记；它不是旧系统迁移器或可直接恢复的完整备份。reset / delete 使旧导出游标失效。完成 reset 后客户端重新拉 snapshot / timeline，清除旧本地投影，不继续套用旧聊天分页。

## 14. HTTP 路由总表

以下为公开入口清单；动态 ID 路由中的大括号只是文档占位符。query 参数、请求体、版本与幂等要求见对应章节。未列出的旧 API 不接受。

| 方法 | 路径 |
| --- | --- |
| GET | `/health` |
| GET | `/v1/status`、`/v1/capabilities`、`/v1/metrics` |
| POST | `/v1/commands` |
| GET | `/v1/snapshot`、`/v1/events`、`/v1/socket`（WebSocket） |
| GET | `/v1/tasks`、`/v1/tasks/{taskId}`、`/v1/pending` |
| GET | `/v1/operations`、`/v1/operations/{operationId}` |
| GET | `/v1/conversations`、`/v1/conversations/{conversationId}/messages` |
| GET | `/v1/interactions`、`/v1/work-items`、`/v1/schedules`、`/v1/sessions`、`/v1/usage` |
| GET | `/v1/connections` |
| POST | `/v1/connections/model`、`/v1/connections/oauth/start`、`/v1/connections/oauth/complete` |
| POST | `/v1/connections/actions`、`/v1/connections/revoke` |
| GET | `/v1/mail/messages`、`/v1/mail/folders`、`/v1/mail/aliases`、`/v1/mail/raw`、`/v1/mail/delta`、`/v1/mail/index` |
| POST | `/v1/mail/read`、`/v1/mail/analysis`、`/v1/mail/attachments/import` |
| GET | `/v1/memory`、`/v1/memory/context` |
| POST | `/v1/history/search`、`/v1/history/read` |
| GET / PUT | `/v1/assets` |
| GET | `/v1/assets/{assetId}`、`/v1/assets/{assetId}/download`、`/v1/assets/{assetId}/text`、`/v1/assets/{assetId}/search`、`/v1/asset-parses/{parseId}` |
| GET | `/v1/connectors`、`/v1/connectors/tools`、`/v1/connectors/operations`、`/v1/connectors/operations/{operationId}` |
| POST | `/v1/connectors/token`、`/v1/connectors/oauth/start`、`/v1/connectors/oauth/complete` |
| POST | `/v1/connectors/discover`、`/v1/connectors/revoke`、`/v1/connectors/read` |
| GET | `/v1/executions`、`/v1/executions/{executionId}` |
| GET | `/v1/notifications`、`/v1/notifications/deliveries` |
| POST | `/v1/notifications/installations/upsert`、`/v1/notifications/installations/revoke`、`/v1/notifications/watch`、`/v1/notifications/unwatch` |
| POST | `/webhooks/gmail`、`/webhooks/graph`（服务商验证） |
| GET | `/v1/account/status`、`/v1/account/export` |
| POST | `/v1/account/reset`、`/v1/account/delete`、`/v1/account/retry` |

## 15. Swift 接入

```sh
swiftc -swift-version 6 -parse-as-library examples/MacoClient.swift -o /tmp/maco-client
export MACO_URL=http://localhost:8787
# MACO_TOKEN 由 App 登录流程提供
/tmp/maco-client snapshot
/tmp/maco-client command task.json
/tmp/maco-client watch 0
```

保存并修改上方 Task JSON，替换实际连接和模型。原生 App 将事件回调接到自己的数据库与 UI，并在登录到期时刷新 token。这个示例不是已经改造完成的 maco-mail 客户端。旧运行、待批发送和设备离线队列的唯一执行归属见 [迁移文档](migration.md)。
