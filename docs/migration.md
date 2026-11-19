# 从旧 Maco / OpenAI 托管 Agent 迁移

**状态更新（2026-11-19）：当前交付是 v0.4 独立 `maco-harness` 后端，先部署新 Worker，再改造 App。** 当前功能与参数以 [README](../README.md)、[客户端协议](protocol.md)、[Cloudflare 部署](cloudflare-deploy.md)为准。新的 Harness、资产/MCP/托管执行/通知及账户生命周期已有代码实现；本仓库尚未替用户部署，也没有完成旧 App 切流。

**阅读方式：以下正文保留 v0.3 基线的迁移原则与历史接入步骤。** 其中“当前能力”“尚未实现”和旧字段示例均属于当时基线，不能覆盖上述三份 v0.4 主文档。端侧摘要/分类、按需复杂任务委派的设计依据见[附件策略](attachments-and-managed-execution.md)；生产原址接替的历史目标见[完整后端迁移方案](full-backend-migration.md)，不是当前部署命令。

**当前没有旧会话、OAuth 凭据、任务、待发邮件或附件的自动导入器，也不兼容旧 `/v1/chat`。** 使用新的用户 DO 和通知 registry，不能直接覆盖 `maco-agent-cloud`、复用其 namespace，或只修改旧 App 的 URL。真实账号切流仍需明确唯一执行者、处理旧待发队列，并在 App 中关闭旧云端/设备直写路径。

下文的操作归属、未知发送结果、身份映射、回滚和逐账号验收原则仍适用于后续生产迁移；它们不表示已经自动执行了迁移。

## 1. 先确定每项操作由谁执行

1. 清点旧系统正在运行的 Agent、待批邮件、定时发送、设备离线队列和后台邮件修改；记录所属用户、邮箱、原任务 / 操作 ID、状态及服务商回执。
2. 为试点账号安排切换时间，停止旧链路接受新的执行任务。旧聊天可以保留为只读归档。
3. 已派发的邮件操作先等待并核对结果；结果不明的发信不能在新系统重新提交。未派发的旧定时邮件若需迁移，先在旧系统取消并确认，再在新系统重新创建和审批。
4. 在 App 接入层建立每个账号唯一的执行归属。切换该账号前，关闭设备直写 Gmail / Graph、旧 Agent 写入、自动已读和定时发送的旧执行入口。
5. 删除“云端失败后设备补写”的 fallback。离线或超时只保留同一命令及其 ID 等待重试，不能转成第二次供应商写入。

这里的账号切流开关需要在实际 App / 发布配置中接入；当前 Worker 没有自动迁移旧队列或暂停旧后端的能力。

## 2. 部署独立验证环境

1. 将 Cloudflare Workers 连接本仓库 `main`，使用 `wrangler.jsonc` 的 `AGENTS` 绑定和 SQLite DO migration；不要复用未知状态的旧执行环境。
2. 配置现有 Supabase 项目的 `SUPABASE_URL` 与 JWT audience。保持同一用户 `sub` 的身份语义；客户端不能指定 DO owner。
3. 配置持久保管的 `CONNECTION_ENCRYPTION_KEY`、Google / Microsoft OAuth 应用与 `OAUTH_REDIRECT_URI`，浏览器再配置精确 `ALLOWED_ORIGINS`。Secrets 不进入 Git。
4. 凭据加密密钥必须跨部署保留。当前没有自动重加密迁移流程，不能随一次发布直接更换密钥。
5. 在部署前执行本地 gate：

```sh
npm ci
npm test
npm run test:worker
npm run check:worker
```

配置实际 Cloudflare 账户后运行 `npm run deploy`，或由 Workers Git 集成部署。检查 `GET /health`、未登录 `/v1/snapshot` 的 401、合法登录请求和 Web CORS；健康检查通过不代表供应商鉴权成功。

## 3. 建立新连接，不复用旧运行状态

1. App 使用 Supabase access token 调用 `POST /v1/connections/model`，提交 `{provider,apiKey}`；后续任务只传返回的 `connectionId`。密钥由用户 DO 的凭据库加密保存，不写入聊天、事件或客户端日志。
2. `openai-compatible` 另需 `baseUrl`，运营方先配置 `MODEL_PROVIDER_HOSTS` 白名单。每个真实模型仍需验证流式输出、工具调用与 effort 支持；“兼容协议”不等于所有模型均已验证。
3. 邮箱调用 `/v1/connections/oauth/start`，打开返回 URL；App / HTTPS 回调页收到 code 后，以同一登录用户调用 `/v1/connections/oauth/complete`。Worker 没有供浏览器直接跳转的 GET callback 页面。
4. 首批连接使用 `actions:[]` 验证读取，再按实际能力授予 modify / write / send 等产品权限；OAuth scope 不足时重新授权。通过 capabilities 渲染真正可用的操作。
5. 现有邮箱连接需走新授权流程；没有上传旧 refresh token 的公开接口。保存新的邮箱连接 ID，不能假设它等于旧 account ID。

当前模型连接使用 API 凭据；没有 ChatGPT / Claude 订阅额度 OAuth。邮箱 OAuth 与模型计费连接是两个独立对象。

## 4. 改造 App 的任务与同步入口

1. 发送消息使用 `POST /v1/commands` 的 `task.create`，传 `modelProfile:{provider,model,effort,connectionId}`、`mailboxId`，需要时传 `timeZone`。
2. 一个新目标创建一个 Task；同一目标的追问用 `task.steer` 并带当前 `taskVersion`。UI 可以合并显示多个 Task，不能把旧 OpenAI session ID 当作新 Task ID。
3. 新设备先取 `/v1/snapshot`，补齐分页，再用 `/v1/events?after=seq` 和 `/v1/socket?after=seq` 持续同步。事件投影与最后已应用的 seq 在客户端同一事务落盘，断线后补缺号并去重。
4. 客户端在发请求前持久保存 `commandId` 与完整负载，重试复用两者。HTTP 202 只是受理；邮箱 UI 应根据 operation 状态和供应商回执更新，不能把受理当作执行成功。
5. App 的手动按钮、自动已读、批量操作与定时发送全部提交 `mail.submit`；Agent 工具调用使用同一 MailCommandExecutor 与操作账本。展示服务端冻结的审批内容，确认时提交对应 `operationId` 和 `approvalVersion`。
6. 移除对 Codex 容器、shell、文件系统和任意 MCP 执行结果的依赖；当前工具范围是已实现的邮箱 API。关闭 App 后云端任务仍可继续，取消必须发明确命令。

## 5. 邮件 ID 与索引逐邮箱启用

先完成连接和按 ID 读取，再显式启动索引；连接邮箱本身不会启动全邮箱轮询：

```json
{"protocolVersion":1,"commandId":"index-start-unique-id","type":"mail.sync","mailboxId":"MAIL_CONNECTION_ID"}
```

- 省略 `after` 默认近 90 天，启动后约每 5 分钟增量检查；通过 `/v1/mail/index?mailboxId=…` 查看状态。初次建基线和游标失效重建期间，不声明完整覆盖。Outlook 初次同步可能枚举更久的历史，不能把 90 天保存范围当作远程工作量上限。
- 新索引返回 `mail_<UUID>`，按“邮箱连接 + 原始 provider message ID”映射。App 保存稳定 ID；迁移兼容期仍可传原始 provider message ID，必须保留大小写。RFC `Message-ID` 邮件头不是执行 ID。
- 修改草稿用 `mail_list_drafts` 返回的 `draftId`。Gmail draft ID、provider message ID 与 Maco 稳定邮件 ID 不能互换或推导。
- 邮件索引只存元数据和正文片段；精确正文用 `mail_read`。`mail_search` 默认 fulltext 走供应商；metadata 只有范围已覆盖、同步完成且足够新时才使用本地索引，否则回退。
- App 和 Agent 都要保留 `coverage`、分页及内容覆盖信息。片段命中不代表全文搜索，空结果不代表邮件不存在，已有本地命中也不能省略用户需要的历史 / 全文搜索。

## 6. 迁移事实与偏好，明确历史边界

1. 经用户确认的账户事实用 `memory.upsert`、`kind:"fact"` 写入；后续修改携带 `expectedVersion`。任务调度时区仍由 `task.timeZone` 决定，记忆不会改变权限或付款连接。
2. 默认 explicit 模式只提取新用户消息中明确的持久回复偏好。更宽泛的 model_proposals 需主动配置，会消耗用户模型连接用量，生成提案后由用户批准。
3. 旧会话继续保留只读入口。当前没有旧 task / message / event 批量导入接口，也没有自动迁入 OpenAI session 或原 App 历史；新系统不能宣称已记住这些记录。
4. 跨任务检索针对已在新用户 DO 中保存的用户 / 助理文字和允许的邮件工具元数据 / 回执投影，带来源和覆盖信息；Agent 可通过 history_search / history_read 继续查证。不要把旧邮件正文、工具回执或模型私有状态伪装成用户陈述来“补历史”。
5. 接入查看、编辑、删除与显式恢复。删除会阻止同一 key 自动恢复，但原聊天和审计事件仍保留；完整账户擦除属于另需完成的产品生命周期工作。

## 7. 真实验收后逐步切流

本地 gate 包含单元 / 服务回归及真实 workerd / SQLite 集成，覆盖历史搜索与精读、上下文压缩、重建恢复和隔离；邮箱和模型 HTTP 使用 fixture。实际通过结果以对应提交的 CI 为准，这不是生产验收。

| 验收项 | 实际环境中必须完成 |
| --- | --- |
| Gmail / Outlook | 各用真实测试账号走 OAuth、刷新 / 撤销、搜索、按 ID 读取、索引续跑，以及对应标签 / 文件夹修改 |
| 发信与草稿 | 对受控收件人批准并发送，核对供应商回执；验证原草稿 ID、重复命令、定时执行与不明结果处理 |
| 模型 | 对要上线的 provider / model 验证流式文字、读写工具、取消、限流和实际 usage；记录首段延迟与总耗时 |
| 多端与隔离 | 同一账号跨设备断线重连，另一账号不可读；验证旧设备队列不会在切流后再次直写 |

先内部账号，再少量用户，最后扩大范围。每一批切换前执行第 1 节的归属核对，比较真实 p50 / p95、错误率、模型账单和索引请求量。App 集成、OAuth 应用配置和这些真实 smoke 都仍需要实际凭据与部署环境。

## 8. 回滚时保留账本，禁止重放外部副作用

1. 停止该批用户提交新任务；按当前版本取消未派发 Task / operation，拒绝待审批操作。已经派发的请求不能靠取消保证撤回，先等待并核对回执。
2. 保留新 DO、事件、连接密钥和操作账本，回滚客户端路由或兼容的 Worker 版本；不能通过清空 DO、改 migration 或生成新 commandId 来“重试迁移”。
3. 对 succeeded 不再执行；对 unknown 先到 Gmail / Outlook 核对，取得证据后用 `mail.reconcile` 记录结果。搜索无结果不足以证明未发送。
4. 完成所有在途、待批、定时与离线队列的归属核对后，才恢复旧链路接受新的任务；不要同时重新打开设备 fallback。回滚不会撤销已经发生的发信或邮件修改。

## 9. 从 0.2 升级到 0.3

保留现有 Worker、AGENTS namespace、连接加密密钥和 OAuth 设置。初始化会新增摘要检查点 / 尝试表，给派生历史索引增加来源和版本字段；原始任务、消息及邮件操作账本不变。

历史索引升级按小批次重建，coverage.hasMore=true 期间只保证已回填部分可搜。精读使用原始消息的公开投影，不必等待全部回填。旧消息没有 createdAt，带时间范围的检索不会把未知时间伪装成已知时间。

客户端 task.create / task.steer 参数保持兼容；需要直接查历史时增加两个只读路由。事件处理器应忽略未知事件，并可选择展示 context.compaction_* 与 Task.context 的覆盖信息。模型调用和摘要仍使用原任务模型连接。

新版本扩展了历史索引表结构。需要回滚时使用兼容这些新增字段的构建；不能直接假设任意 0.2 构建仍能写入扩展后的派生索引。保留原消息和账本，优先向前修复或发布兼容回滚版，不清空用户 DO 来降级。
