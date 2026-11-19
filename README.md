# Maco Harness

**v0.4 是可独立部署的 Cloudflare 邮件助理后端。** 仓库包含 Worker、每用户 SQLite Durable Object、私有 R2 资产层、调度器、通知注册表、测试与部署配置。先部署新的 `maco-harness`，再让 App 接入[客户端协议](docs/protocol.md)。它不兼容旧 `/v1/chat` API，也不会自动继承 `maco-agent-cloud` 的聊天、OAuth 凭据、待发邮件或附件；不要直接覆盖旧 Worker 或仅修改旧 App 的 URL。

常规路径为 **App → Cloudflare Worker / 用户 DO → 模型或 Gmail / Microsoft Graph → Cloudflare → App**。Supabase 只承担登录身份，Worker 校验 JWT；邮件和模型请求不经 Supabase 转发。邮件操作不启动沙盒。复杂文件任务可以在用户明确允许后委派给另行计费的托管 Agent，完成后将结果收回同一任务。

## 从 GitHub 部署

在 Cloudflare Workers Builds 中连接 [sim-628/maco-harness](https://github.com/sim-628/maco-harness)：

| 设置 | 值 |
| --- | --- |
| 分支 / 根目录 | `main` / `/` |
| Worker 名称 | `maco-harness`，与 `wrangler.jsonc` 一致 |
| Build command | `npm ci && npm run check` |
| Deploy command | `npm run deploy` |
| 构建 Node 版本 | `24.22.3`，与 `.node-version` 一致 |

`wrangler.jsonc` 声明 `AGENTS → MacoAgent`、`NOTIFICATIONS → NotificationRegistry`、自动创建的 `ASSETS` R2 桶和 `AI` binding。保留已有 `v1` / `v2` migration，部署到新的资源。基础运行时配置是 `SUPABASE_URL` 与 `CONNECTION_ENCRYPTION_KEY`；浏览器来源、邮箱 OAuth、MCP、OCR、托管执行与推送按需配置。构建变量与 Worker 运行时 Secrets 是两套设置。

新 Worker 不需要 `SUPABASE_SERVICE_ROLE_KEY`。运营方凭据可用普通 Worker Secret 或 Cloudflare Secrets Store 原生 binding，用户自己的大量 key 继续用加密连接 ID；主加密密钥保持固定。具体填写方法、稳定引用和 Git 部署规则见[环境变量与 Secrets Store](docs/environment-and-secrets.md)。

详细配置、部署验收与可选功能条件见 [Cloudflare 部署](docs/cloudflare-deploy.md)。GitHub 发布和本地测试不表示已在你的 Cloudflare、邮箱或 Apple 账户完成部署与联调。

## 已实现的能力

| 能力 | 实现与边界 |
| --- | --- |
| 多模型 | `openai`、`anthropic`、`deepseek`，以及运营方域名白名单内的 `openai-compatible` Chat Completions |
| 自有 Harness | 持久模型循环、读工具并行、写工具屏障、取消、steering、有界上下文、压缩检查点与中断恢复 |
| 一个助理、多个任务 | 默认 `primary` 聊天时间线汇总多个 Task；任务可绑定多个邮箱、MCP 与文件，也可不绑定邮箱 |
| 多端同步 | 快照、持久事件、HTTP 回放、休眠 WebSocket、版本化交互问题与待办事项 |
| 邮箱 API | Gmail / Graph 的读取、列表、原始 MIME、组织结构及已接入的修改；手动操作与 Agent 共用审批和回执账本 |
| 邮件索引与设备分析 | 稳定邮件 ID、元数据与片段、同步覆盖和删除标记；端侧摘要 / 分类版本化同步，没有云端批量推理兜底 |
| 个人记忆 | 用户编辑的账户事实、明确偏好提取、可选模型偏好提案；跨任务历史搜索与按 ID 精读 |
| 附件 | 私有 R2 上传 / 下载、邮箱附件导入、持久解析任务、文本读取 / 搜索；Cloudflare 文档转换与可选独立 OCR |
| MCP | 运营方批准的远程服务器与工具；每用户 token / OAuth、只读调用、冻结参数审批和未知结果核对 |
| 托管复杂任务 | 可选 OpenAI Agents Sessions 执行器；显式 `allowHosted`、独立运营方 key、受限附件输入和产物回收 |
| 定时任务 | 持久、只读的周期任务；每账户每 UTC 日最多启动 24 次，不自动授权外发或 MCP 写入 |
| 身份与生命周期 | 每用户加密凭据、epoch、会话即时撤销、分阶段 reset / delete、分页数据导出 |
| 用量与通知 | 按调用来源记录模型用量，未知值保留为 `null`；Gmail / Graph webhook、APNs 安装与投递账本，需配置并实测 |

任务的模型配置为 `provider / model / effort / connectionId`。用户只在创建连接时提交 API key，后续引用加密连接 ID；兼容服务商的 `baseUrl` 也在连接创建时固定。effort 不被支持时返回明确警告。**本仓库没有 ChatGPT / Claude 订阅额度 OAuth 接入；API 调用不能自动使用聊天产品订阅额度。**

## 邮件修改只走云端 API

App 提交意图、展示冻结的审批内容并同步结果。所有已接入的修改由云端 Gmail / Graph API 执行，不能另起设备直写或离线重试路径。

| 产品授权 | 覆盖操作 |
| --- | --- |
| 默认 `actions: []` | 搜索、邮件 / 线程、组织结构、草稿、附件元数据与受限文本读取 |
| `modify` | 已读、旗标、归档、恢复、垃圾邮件 / 重要标志，以及供应商支持的标签、文件夹、分类 |
| `write` | 创建 / 更新草稿；Outlook 追加 / 移除草稿附件，移除需要逐次审批 |
| `move_to_trash` | 移入垃圾箱 |
| `send`、`reply`、`forward` | 分别授权，每次外发批准实际收件人、内容与附件摘要 |
| `delete_draft` / `delete_label` | 独立授权、逐次审批；后者仅为 Gmail 用户标签，不删除邮件 |

产品授权与 OAuth scope 分别检查。动作目录采用两家服务商能力的并集，每个连接只开放实际支持且获准的子集。普通邮件永久删除、文件夹删除、导入 / 复制邮件、规则与账户设置没有接入；不能把“并集”理解成已实现两家全部 API。详见[动作和审批协议](docs/protocol.md#5-邮箱修改与审批)。

外发附件可以引用同邮箱原附件或 R2 `assetId`，最多 12 份、合计 **512 KiB**。发信仍冻结实际字节并审批；10 MiB 文件上传 / 解析额度不会扩大邮件发送限额。网络结果不确定时记为 `unknown`，需核对后 reconcile，不自动重发。

## 附件与复杂任务

上传默认上限 **10 MiB / 文件**。每次新任务输入最多 4 个资产，任务在工具导入与产物回收后最多保留 64 个引用。纯文本在 Worker 本地解析；常见文档通过 `AI.toMarkdown` 转换，实际格式以运行时 `supported()` 为准。PDF 的文本提取不保证读到扫描页；图像描述不等于可靠 OCR。

配置 `DEEPSEEK_OCR_API_KEY` 后可显式选择独立 OCR，解析结果仍保存为与最终模型无关的文本 / 页信息。每份结果返回 `unverified / partial / complete` 和警告；OCR 的 `complete` 只表示服务商报告的页完成状态，不保证识别准确率。`auto` 对 PDF 优先走 Cloudflare，不能把它当成自动识别扫描件的保证。

需要代码计算、复杂表格或文档产物时，可启用托管执行器。它只接收选定输入和文件，不接收邮箱 / MCP 凭据或完整历史；产物回到私有 R2，后续发送继续走本地审批。没有运营方托管配置或 Task 的 `allowHosted:true` 就不能使用此路径。API 模型、OCR、托管计算、R2 和通知分别产生用量，`/v1/usage` 不是完整供应商账单。

## 索引、记忆与历史

显式 `mail.sync` 启动元数据索引，默认保存近 90 天，随后约每 5 分钟检查变化；启用 webhook 后可更早唤醒同步。`mail_search` 默认全文搜索走服务商，只有覆盖完整且足够新的 metadata 查询才走本地。片段不等于全文；Outlook 初次 delta 可能枚举窗口外项目，90 天保存范围不等于远程枚举量。

稳定事实由用户编辑。默认偏好提取不额外调用模型，只识别用户本人短句中明确、持久的语言、长度与语气偏好；`model_proposals` 可提取更宽泛的候选，要求原句证据并经批准生效。历史使用 SQLite FTS 与中文双字，按任务资源范围检索用户 / 助理文字及允许的邮件元数据和回执投影。它不等于向量语义检索，也不把所有历史发送给模型。

长任务保留原始记录并生成有界摘要检查点，默认输入预算为保守估计的 64 KiB，压缩消耗原模型连接的 API 用量。删除记忆会使旧派生上下文退出召回；删除一条记忆不删除原聊天。账户 reset / delete 另有持久清理流程，未知外部结果会保留最小核对记录；删除本后端数据不删除供应商邮件或 Supabase 登录身份。详见[历史与上下文](docs/history-and-context.md)及[生命周期协议](docs/protocol.md#13-账户导出重置与删除)。

## 分层与容量

| 职责 | 源码 |
| --- | --- |
| JWT、HTTP / WebSocket、路由 | `src/auth.mjs`、`src/http.mjs`、`src/worker.mjs` |
| 应用编排、事务、幂等命令与事件 | `src/service.mjs`、`src/store.mjs` |
| Task、调度、上下文与模型协议 | `src/harness.mjs`、`src/scheduler.mjs`、`src/task-scope.mjs`、`src/model/` |
| 加密连接、MCP | `src/connections/`、`src/connectors/` |
| 邮箱读写、审批、索引 | `src/mail/`、`src/mail-executor.mjs`、`src/mail-ui.mjs`、`src/mail-index/` |
| 文件与托管执行器 | `src/assets/`、`src/executors/`、`src/runtime-tools.mjs` |
| 事实、偏好与历史 | `src/memory/`、`src/history/`、`src/history-projection.mjs` |
| 交互、设备分析、定时任务与用量 | `src/interactions.mjs`、`src/client-state.mjs`、`src/schedules.mjs`、`src/usage.mjs` |
| 会话、账户清理与通知 | `src/sessions.mjs`、`src/account/`、`src/notifications/` |

每用户默认并发 2 个模型任务、4 个邮件写操作、3 个维护步骤；同资源写入保持顺序，后台模型任务最多同时占 1 个槽。默认最多 32 个未结束任务、256 个待处理邮件操作。等待审批、用户输入、外部执行和退避释放模型槽。后台模块统一由用户 DO alarm 调度，无需额外服务器、Cron 或队列。

## 验证与 App 接入

```sh
npm ci
npm run check
```

`check` 包含替身服务测试、真实 workerd / SQLite DO / R2 集成测试与部署 dry-run，不会部署。GitHub CI 执行同类检查。真实 OAuth、模型兼容性、扫描件质量、托管产物和 APNs 投递仍需部署后的专门测试；本地通过不证明生产 p50 / p95、费用或 APNs HTTP/2 兼容性。

App 后续必须接入新命令 / 事件协议、连接 ID 与版本检查，并停用旧云端执行器和设备直写队列后再切流。旧数据与 OAuth 授权没有自动迁移器，旧 Graph watch 也不会被新 Worker 自动接管。Supabase Auth、网站 / passkey 等原系统职能仍需单独保留或迁移。

- [Cloudflare 部署与真实验收](docs/cloudflare-deploy.md)
- [环境变量、凭据索引与 Secrets Store](docs/environment-and-secrets.md)
- [客户端协议与全部路由](docs/protocol.md)
- [旧 Maco 迁移原则](docs/migration.md)
- [完整后端迁移目标与验收清单](docs/full-backend-migration.md)
- [附件与托管执行设计依据](docs/attachments-and-managed-execution.md)
- [Swift 协议示例](examples/MacoClient.swift)（示例，不代表现有 App 已改造）

## 来源

模型循环基线参考 [DeepSeek Harness `ca33fd6`](https://github.com/deepseek-ai/deepseek-harness/tree/ca33fd6843b205e279c7ccb6cb73a472c78f5760)，历史搜索与持久压缩参考 [`2e39e704`](https://github.com/deepseek-ai/deepseek-harness/tree/2e39e70496aa02986ca6a820c5d497e816b69d7e)。移植代码注明来源并保留[上游 MIT 许可证](licenses/deepseek-harness-MIT.txt)，适配到用户 DO SQLite，不引入其 Node Host 或文件型数据库。邮箱行为参考[旧 Maco 固定审查版本](https://github.com/sim-628/maco-mail/tree/d1b6dfc6c77545d60092e6c8f42db43f882f34ff)。设计文档记录背景与迁移目标，当前接口与功能条件以本 README、部署文档及协议为准。
