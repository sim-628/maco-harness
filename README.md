# Maco Harness

部署在 Cloudflare 的邮件 Agent 后端。每个登录账号拥有一个 Durable Object 和 SQLite 数据库，承载多个独立任务、统一事件流、邮箱操作、邮件索引和个人记忆。iOS、macOS、Web 可以展示同一个个人助理并同步执行结果；模型只收到当前任务需要的上下文。

运行路径为 **用户 → Cloudflare Worker / 用户 DO → 模型或 Gmail / Microsoft Graph → Cloudflare → 用户**。无需 Codex 沙盒、容器、单独的 Agent 服务或向量数据库。Supabase 承担现有 App 的身份认证，Worker 直接校验 JWT；模型与邮箱请求不经 Supabase 转发。

## 直接连接 Cloudflare

在 Cloudflare Workers 中连接 [sim-628/maco-harness](https://github.com/sim-628/maco-harness)，填写：

| 设置 | 值 |
| --- | --- |
| 分支 | `main` |
| 根目录 | `/` |
| Worker 名称 | `maco-harness`，与 `wrangler.jsonc` 一致 |
| Build command | `npm ci && npm test && npm run test:worker` |
| Deploy command | `npm run deploy` |
| Node | 使用仓库 `.node-version`；最低要求见 `package.json` |

配置运行时认证、凭据加密与邮箱 OAuth 后才能连接真实账号。Git 集成不会自动创建 Supabase 项目、OAuth 应用或回调页。完整步骤见 [Cloudflare 部署](docs/cloudflare-deploy.md)。

## 已实现的能力

| 能力 | 实现与边界 |
| --- | --- |
| 多模型 | `openai`、`anthropic`、`deepseek` 预设；`openai-compatible` 支持运营方域名白名单内的 Chat Completions 流式与工具调用 |
| 云端 Harness | 自有模型循环、上下文裁剪、读工具并行、写工具屏障、取消、steering、预算与中断恢复 |
| 多端同步 | 持久事件、快照、增量回放、WebSocket 休眠与重连；同一用户多个 Task |
| 邮箱读写 | Gmail / Outlook；Agent、手动按钮和后台修改共用命令账本、授权、审批、版本检查与回执 |
| 邮件索引 | 稳定 ID、元数据及正文片段；有界本地检索、覆盖标记、服务商搜索回退、按 ID 读取和操作 |
| 稳定账户事实 | 用户显式编辑、有来源、有版本；不从邮件或模型猜测自动生成事实 |
| 跨任务历史 | 同账号用户 / 助理文字的相关片段、中文双字切分、来源 Task / message ID、有界上下文 |
| 长期偏好 | 默认零额外模型调用的明确偏好提取；可选持久后台模型提案，证据绑定、批准后生效 |
| 凭据隔离 | 每用户连接、加密保存 token / API key、PKCE、同一授权的刷新合并、epoch 撤销 |

任务配置使用 `provider / model / effort / connectionId`。API key 在创建连接时提交并加密保存，后续只引用连接 ID；自定义服务商 `baseUrl` 也只在连接创建时配置。effort 按供应商能力处理，不支持时产生明确警告。

**本仓库没有 ChatGPT / Claude 订阅额度 OAuth 接入。** 当前实现使用模型 API 凭据，不能把聊天产品订阅自动当作第三方 App 的 API 额度。

## 邮箱操作原则

App 提交意图、展示审批并同步结果；所有已接入的邮箱修改都由云端 Gmail / Graph API 执行。

| 产品授权 | 覆盖操作 |
| --- | --- |
| 默认 `actions: []` | 读取：搜索、邮件 / 线程、组织结构、已有草稿、附件元数据及受限文本附件 |
| `modify` | 已读、旗标、归档、恢复、垃圾邮件 / 重要标志及供应商支持的标签、文件夹、分类 |
| `write` | 创建 / 更新草稿；Outlook 追加 / 移除草稿附件，移除需要逐次审批 |
| `move_to_trash` | 仅 `trash`，移入垃圾箱 |
| `send`、`reply`、`forward` | 分别授权，每次外发审批实际内容 |
| `delete_draft` | 删除现有草稿，独立授权、逐次审批 |
| `delete_label` | Gmail 用户标签；移除所有邮件上的该标签，不删除邮件；独立授权、逐次审批 |

产品授权和 OAuth scope 分别检查。动作目录采用两家服务商能力的并集，每个连接只开放实际支持且获准的子集。完整参数见 [客户端协议](docs/protocol.md)。普通邮件永久删除、文件夹删除、导入 / 复制邮件、规则和账户设置等尚未接入。

可读取 UTF-8 纯文本、Markdown、CSV、JSON 附件，单份上限 48 KiB。外发可引用同一邮箱的原附件，包括二进制附件，总量上限 512 KiB、最多 12 份；批准绑定实际字节摘要。没有 PDF / Office 解析、任意 shell、通用 HTTP 或任意 MCP 执行。

## 索引和个人记忆

显式提交 `mail.sync` 后启动索引，初始回填窗口默认为近 90 天，随后约每 5 分钟增量检查，只落元数据与片段；按需读取也可能记录窗口外的邮件。`mail_search` 默认 `fulltext`，走服务商搜索；明确的 `metadata` 查询在时间范围已覆盖、索引完整且足够新时才走本地。片段搜索不等于全文搜索，无结果不等于邮件不存在。Outlook 初次同步可能枚举大量历史项目，90 天保存窗口不等于远程只枚举 90 天。

个人记忆默认 `explicit`，仅自动保存用户本人短句中明确、持久的回复语言、长度和语气偏好，不是通用自然语言抽取。`model_proposals` 对更宽泛的候选偏好执行持久后台模型提取，要求原句证据并等待用户批准；仍消耗连接的 API 用量，默认在没有前台模型任务时运行。

相关历史只使用本账号用户 / 助理文字，不直接引入其他任务的工具回执、邮件正文或模型私有状态；关键词与中文双字检索不是向量语义检索。删除记忆清除活动值和证据，保留防止自动恢复的 tombstone，并抑制其来源再次进入相关历史；原聊天、历史事件和审计记录仍保留。整账户物理擦除及保留期限需要接入正式产品生命周期。

邮件索引不存完整正文；按需读取的正文或附件文本仍可能保存在当前 Task 的工具回执中，发送审批预览也会保留内容。两类存储的用途和保留期应分别管理。

## 本地验证

```sh
npm ci
npm test
npm run test:worker
npm run check:worker
```

单元测试使用模型 / 邮箱替身，集成测试使用真实 workerd / DO SQLite。`check:worker` 是构建检查，不是部署。配置 `.dev.vars` 后运行 `npm run dev`，健康检查为 `GET /health`。

## 分层和容量

| 职责 | 源码 |
| --- | --- |
| JWT、HTTP / WebSocket、每用户路由 | `src/auth.mjs`、`src/http.mjs`、`src/worker.mjs` |
| 应用编排 | `src/service.mjs` |
| 事务、幂等命令、事件和快照 | `src/store.mjs` |
| Task 调度、alarm、中断恢复 | `src/scheduler.mjs` |
| 模型循环、工具屏障、上下文、预算 | `src/harness.mjs`、`src/tool-policy.mjs`、`src/model/` |
| 加密连接与 OAuth 生命周期 | `src/connections/` |
| 邮箱协议、冻结请求、审批和回执 | `src/mail/`、`src/mail-executor.mjs` |
| 邮件索引和游标 | `src/mail-index/` |
| 事实、偏好、提案与相关历史 | `src/memory/` |

每用户默认并发 2 个模型任务、4 个邮件写操作、1 个后台维护步骤；同资源写入保持顺序。默认最多 32 个未结束任务、256 个待处理邮件操作，配置上限分别为 256 / 2048。等待审批、定时执行和退避释放模型槽。详见 [架构](docs/architecture.md)。

## 接入与迁移

- [客户端协议与请求示例](docs/protocol.md)
- [Cloudflare 部署](docs/cloudflare-deploy.md)
- [旧 Maco 迁移](docs/migration.md)
- [Swift 客户端示例](examples/MacoClient.swift)
- [已有 Notion 策略](https://app.notion.com/p/41cfdd4befa181379301f86bebeabf75)

## 来源与验证边界

基线参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `ca33fd6843b205e279c7ccb6cb73a472c78f5760`。移植代码来源保留在文件头和 [上游 MIT 许可证](licenses/deepseek-harness-MIT.txt)。邮箱行为核对了 [旧 Maco 审查版本](https://github.com/sim-628/maco-mail/tree/d1b6dfc6c77545d60092e6c8f42db43f882f34ff) 的 Gmail / Outlook 服务、云端工具、定时邮件与账户连接实现。

本地测试和构建不等于真实 Gmail / Microsoft OAuth、第三方模型兼容性或生产性能验收。真实邮箱、发送测试、历史回填量、生产 p50 / p95、原生客户端切流和数据保留策略仍需在实际产品环境完成。
