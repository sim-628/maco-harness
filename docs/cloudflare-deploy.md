# Cloudflare 部署与运行配置

本指南对应 v0.4：先从 GitHub 独立部署 `maco-harness`，配置并验证需要的服务，再改 App 接口。仓库包含实现、测试和资源声明；真实 OAuth、模型、OCR、托管执行和推送需要部署后的联调。旧 `maco-agent-cloud` 与现有 App 不在本次部署中改动。

## 1. 连接 GitHub 并部署新 Worker

在 Cloudflare **Workers & Pages → 创建 Worker → 导入 Git 仓库**中选择 [sim-628/maco-harness](https://github.com/sim-628/maco-harness)。界面名称可能随 Dashboard 更新，以 Workers Builds 的构建 / 部署字段为准。

| 配置 | 值 |
| --- | --- |
| Worker 名称 | `maco-harness` |
| 生产分支 / 根目录 | `main` / `/`，只指新 Worker |
| Build command | `npm ci && npm run check` |
| Deploy command | `npm run deploy` |
| Node 版本 | 根目录 `.node-version` 固定 `24.22.3`；也可设同值的构建变量 `NODE_VERSION` |

`npm run check` 执行本地测试、workerd 集成测试和构建 dry-run，不访问真实邮箱或部署生产资源。构建成功后，deploy 才发布 Worker。Cloudflare 支持从 `.node-version` 选择 Node；可设置构建变量 `SKIP_DEPENDENCY_INSTALL=1`，由这里的 `npm ci` 单独安装锁定依赖。参考 [Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)与[构建镜像](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。

### 仓库自动声明的资源

| Binding / migration | 用途 |
| --- | --- |
| `AGENTS → MacoAgent`，`v1` SQLite migration | 每 Supabase 用户的任务、邮件索引、凭据、记忆与事件 |
| `NOTIFICATIONS → NotificationRegistry`，新增 `v2` SQLite migration | webhook owner 路由与共享 APNs JWT 缓存 |
| `ASSETS` R2 binding，无 `bucket_name` | Wrangler 为新 Worker 自动配置独立资产桶 |
| `AI` Workers AI binding | 可选文档转换；普通模型会话不依赖它 |

账号需要已启用使用到的 Cloudflare 产品，部署身份需要相应权限。R2 不填写旧桶名；自动创建的资源可在 Dashboard 查看，GitHub 部署不会把生成的资源标识写回仓库。后续使用同一 Worker 和资源；保留 `v1` / `v2` migration，不能删除历史迁移来“重新开始”。参见 [Wrangler 自动资源配置](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)。

旧系统使用 `ACCOUNTS → AgentAccount` 与 `maco-chat-private`，不是新 Worker 的存储。不要改名覆盖旧 Worker，不要绑定旧 DO namespace 或旧资产桶。同一个 JWT `sub` 不会合并新旧数据。

## 2. 配置 Worker 运行时变量与 Secrets

在 **Worker → Settings → Variables and Secrets** 设置运行时值。Build variables 仅供构建；把凭据只放在构建环境中，线上代码读不到。`keep_vars:true` 保留 Dashboard 的运行时变量。完整模板见 [`.dev.vars.example`](../.dev.vars.example)，真实秘密不提交 GitHub。

### 最小可用：身份与模型连接

| 名称 | 类型 / 条件 |
| --- | --- |
| `SUPABASE_URL` | 必需变量；现有项目的 HTTPS origin，无附加路径 |
| `CONNECTION_ENCRYPTION_KEY` | 必需 Secret；32 字节随机值的 base64，部署后稳定保留 |
| `JWT_AUDIENCE` | 可选变量，默认 `authenticated` |
| `ALLOWED_ORIGINS` | Web 客户端需配置精确 origin，逗号分隔，包含实际端口 |
| `MODEL_PROVIDER_HOSTS` | 启用自定义兼容模型时配置精确受信任 DNS 主机，无通配符、IP 或内网地址 |

生成一次主密钥：

```sh
openssl rand -base64 32
```

保存输出为 Secret。直接换值会使已保存连接无法解密；正式轮换需要重加密迁移。不要用 Supabase service role 或用户 token 代替主密钥。

验证器支持 Supabase ES256 / RS256 JWKS，校验签名、issuer、audience、角色、subject 与到期时间。旧 HS256 项目需要先迁移签名配置；Worker 不需要 service role。App 登录后携带 access token，模型 key 由各用户调用 `POST /v1/connections/model` 保存到自己的加密连接，通常不需要全局模型 Secret。

没有邮箱、MCP、OCR 或托管配置时，仍可创建不绑定这些资源的普通模型 Task。`GET /v1/status` 查看当前功能配置，`GET /v1/capabilities` 查看具体模型 / 邮箱能力；这些结果不等于外部账号已经联调成功。

### 邮箱 OAuth

| 名称 | 条件 |
| --- | --- |
| `OAUTH_REDIRECT_URI` | 已部署的 App / Web 回调 HTTPS URL |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | 启用 Gmail 必需，secret 使用 Secret 类型 |
| `MICROSOFT_CLIENT_ID`、`MICROSOFT_CLIENT_SECRET` | 启用 Outlook 必需，secret 使用 Secret 类型 |

流程为：已登录 App 调用 `oauth/start` → 打开返回的授权 URL → 你的回调页面接收 code / state → 同一登录用户携带 access token 调用 `oauth/complete`。Worker **没有公开 GET OAuth 回调页面**，不能把 POST `/v1/connections/oauth/complete` 直接注册成浏览器 redirect URI。复用现有安全回调页 / 深链桥接，或提供一个实际回调页面。

产品 actions 默认只读；OAuth scope、应用发布 / 审核及租户政策需要在 Google / Microsoft 项目完成。提高产品 action 不自动增加 scope。新授权生成的新连接 ID、provider account ID、scope 与 epoch 以返回值为准；旧 refresh token 没有自动导入入口。

### MCP：默认关闭

`MCP_SERVERS={}` 不开放任何服务器。启用时配置运营方批准的 HTTPS endpoint、真实工具名称和策略；每个工具必须显式声明 `mailWrite:false`，写工具必须审批。例如：

```json
{
  "notes": {
    "endpoint": "https://mcp.example.com/mcp",
    "tools": {
      "search": {"access":"read","approval":"never","mailWrite":false},
      "create": {"access":"write","approval":"always","mailWrite":false}
    }
  }
}
```

示例域名与工具不代表内置可用服务。用户只提交 `serverId` 和自己的 token / OAuth 授权，不决定远程地址、权限策略或请求头。只读 Task 不暴露写工具或需要审批的 MCP 工具。

OAuth 还需运营方固定 issuer、发现地址、允许的授权 / token endpoint、客户端注册信息与 HTTPS 回调页；使用 `MCP_OAUTH_REDIRECT_URI`，未配置则回退 `OAUTH_REDIRECT_URI`。详见 [MCP 配置](../src/connectors/README.md)。`CONNECTOR_ENCRYPTION_KEY` 可选，不设置时使用主密钥；不要填空字符串来表示“省略”。

### 附件与 OCR

| 配置 | 用途 |
| --- | --- |
| `ASSETS` R2 binding | 上传、私有下载、解析结果与托管产物 |
| `AI` binding | `toMarkdown` 文档转换，运行时检查支持格式 |
| `DEEPSEEK_OCR_API_KEY` Secret | 可选独立 OCR；没有它不会自动启用收费 OCR |
| `ASSET_AUTO_OCR=deepseek` | 可选；允许 auto 对需要 OCR 的受支持格式选择 DeepSeek；PDF auto 仍优先 Cloudflare |
| `ASSET_MAX_BYTES` | 默认 `10485760`（10 MiB / 文件） |
| `ASSET_MAX_FILES`、`ASSET_MAX_ACCOUNT_BYTES` | 默认 `2048` 个、`268435456` 字节 / 用户 |
| `ASSET_MAX_PARSED_BYTES` | 默认 `2097152`（2 MiB 文本输出） |

纯文本不调用外部解析器。PDF / Office 转换不保证扫描页、复杂布局和表格语义完整；精确扫描件需求应显式选择 OCR 并检查页覆盖与警告。缓存与持久任务减少重复请求；收费 OCR 的未知结果不会自动重试。资产上传 / 解析 10 MiB 与邮件外发合计 512 KiB 是独立限额。

### 托管复杂执行：默认关闭

| 名称 | 条件 / 默认 |
| --- | --- |
| `HOSTED_AGENT_ENABLED` | 显式设 `true` 才启用 |
| `OPENAI_AGENTS_API_KEY` | 独立运营方 Secret，按该账户计费 |
| `HOSTED_AGENT_MODEL` | 启用时必须指定有权限使用的真实模型 |
| `HOSTED_AGENT_PROFILE` / `HOSTED_AGENT_EFFORT` | 默认 `document-analysis` / `medium` |
| `HOSTED_AGENT_TIMEOUT_MS` | 默认 `300000` |
| `HOSTED_AGENT_REQUEST_TIMEOUT_MS` / `HOSTED_AGENT_POLL_MS` | 默认 `20000` / `3000` |
| `MAX_OPEN_HOSTED_TASKS` | 默认每用户 `2` |

Task 还必须带 `allowHosted:true`；启用运营方配置不等于用户允许每个任务上传文件。托管路径仅接收选择的输入，网络、桌面和多 Agent 能力关闭，无邮箱 / MCP 凭据。默认最多 4 个输入（各 10 MiB，合计 40 MiB）、4 个输出（各 10 MiB，合计 20 MiB）。产物导入 R2 后，发邮件仍走冻结审批。该账户付费与用户自己的模型连接、ChatGPT 订阅分别计算。

### 通知：APNs 与服务商 webhook

| 名称 | 条件 |
| --- | --- |
| `APNS_TEAM_ID`、`APNS_KEY_ID`、`APNS_TOPIC` | Apple 团队、密钥 ID、与 App 匹配的 topic |
| `APNS_PRIVATE_KEY` | Secret；有效 .p8 私钥 |
| `APNS_ENVIRONMENT` | `production` 默认；开发设备 token 使用 `sandbox` |
| `NOTIFICATION_BASE_URL` | 新 Worker 固定公网 HTTPS origin，Graph 回调以此生成 |
| `GMAIL_PUBSUB_TOPIC` | Google `projects/.../topics/...` |
| `GMAIL_PUBSUB_SUBSCRIPTION` | 对应 `projects/.../subscriptions/...` |
| `GMAIL_PUBSUB_AUDIENCE` | Pub/Sub push OIDC 的精确 audience |
| `GMAIL_PUBSUB_SERVICE_ACCOUNT` | 预期签名身份的服务账号 email |
| `NOTIFICATION_ENCRYPTION_KEY` | 可选 Secret；省略时使用主密钥，不填空字符串 |

Google Pub/Sub topic、push subscription、OIDC 服务账号和发布权限需要在 Google 项目配置，Cloudflare 不会创建它们。Gmail watch 使用的 topic 应符合 Google 项目要求，并向 `gmail-api-push@system.gserviceaccount.com` 授予发布权限；push endpoint 为 `https://<新域名>/webhooks/gmail`。Outlook webhook 为 `/webhooks/graph`，注册时完成 validationToken 验证，并按订阅 clientState 验证后续通知。

App 登录后注册 APNs installation，再为自己的邮箱调用 watch。通知仅携带通用唤醒 / 状态提示，客户端获取实际数据；不会把完整邮件内容放入推送。Gmail / Graph 的 watch 续期、事件去重和有界重试由 DO alarm 完成，无需单独 Cron。

**部署后必须验证真实 APNs 接受与设备收取。** APNs 要求 HTTP/2；Workers `fetch` 没有显式强制 HTTP/2 的参数，本地替身测试不能证明这条链路。需在部署环境确认 APNs 返回 200，再确认实际 App 收到；200 也不保证设备最终呈现通知。

旧 Graph subscription 不能仅凭邮箱相同就继承。切流前确定旧订阅的停用 / 到期与新订阅的创建顺序，避免冲突。当前 unwatch 停止本地路由和续期，不调用 Gmail stop，也不删除远端 Graph subscription；已创建的远端 watch 会自然到期。重新启用或迁移时可能需要订阅核对与交接。

## 3. 部署后最短验收

使用专门的测试账户与测试邮件，按启用范围验收：

1. `GET /health` 可达；带真实用户 JWT 读取 status / snapshot，换另一个用户验证任务、连接和文件隔离。
2. 保存一个模型连接，运行无邮箱 Task；检查主时间线、流式事件、跨设备回放和 usage。撤销设备会话，确认旧 token / WebSocket 无法继续访问。
3. 配置 Gmail / Outlook OAuth 回调，读取列表与原始 MIME，启动 mail.sync，核对稳定 ID、增量 / 删除标记和覆盖范围。
4. 对测试邮件执行可逆修改；外发只向测试收件人，核对批准前无派发、实际内容一致、重复 commandId 不重复执行。
5. 上传纯文本、普通 PDF、扫描 PDF 和实际 Office 样本，核对 hash、权限、解析覆盖与 warning；删除后无法下载，后台清理完成。
6. 按需验证真实 MCP 的读写策略与 OAuth 刷新、托管执行的输入 / 产物回收、定时只读任务、交互回答与设备分析同步。
7. 启用通知时，实测 Gmail Pub/Sub OIDC、Graph 订阅 / 续期、APNs HTTP/2 接受和设备投递，再完成旧订阅交接。
8. 用测试账户执行 export、reset、delete，核对状态推进与 unknown / blocked 的处理；不在真实用户上把删除当作健康检查。

这些步骤是你的部署验收清单，不表示仓库制作期间已在真实账户执行。日志与 traces 已启用采样；`/v1/metrics` 是用户级局部时延，生产端到端 p50 / p95、容量与成本仍需真实测量。

## 4. App 切流边界

新 Worker 部署成功后，旧 App 不能只换 URL。后续客户端至少需要：

- 采用新连接、任务 / timeline、幂等 commandId、JSON events / WebSocket、审批与版本字段。
- 邮件修改统一提交给 Worker；停用旧 Agent、旧云任务与设备 Gmail / Graph 直写 / 离线队列后，才给新执行器写权限。
- 重新授权新邮箱 / MCP 连接，或另外实现并审核凭据迁移；建立新旧邮件与任务 ID 映射。当前没有旧历史 / 密文 / 待发操作导入器。
- 接入新的会话撤销、通知安装 / watch 与账户生命周期；保留尚未迁移的 Supabase Auth、网站、passkey 等外围功能。

切流可按用户分批；未知外部操作须先核对，不能复制到新系统再次派发。完整背景见[迁移清单](full-backend-migration.md)。

## 5. 本地检查与故障定位

```sh
npm ci
npm run check
cp .dev.vars.example .dev.vars
# 填入本地联调所需值；不要提交真实 secret
npm run dev
```

| 现象 | 优先检查 |
| --- | --- |
| 401 / JWT 不接受 | 项目 origin、签名算法、audience、到期 / 已撤销会话；不能使用 anon / service role key |
| CORS / OAuth callback 失败 | 页面 origin 白名单、真实 HTTPS 回调页与同一登录用户；POST complete 不是回调页面 |
| R2 / DO 绑定缺失 | 部署权限、账号产品启用、Worker 名称与 migrations；不要误绑旧生产资源 |
| 凭据解密失败 | 主密钥是否替换、缺失或只写在 Build 环境 |
| 解析 `unverified` / `partial` | 读取 warning，检查扫描页、截断、格式与 OCR 配置，不当成“完整读完” |
| operation / execution 为 `unknown` | 核对外部状态并走 reconcile / 清理，不能新建请求盲目重发 |
| 409 审批 / epoch / generation 冲突 | 重新读取当前预览、连接或账户状态 |
| APNs 无投递 | topic、环境、设备 token、密钥、真实 HTTP/2 接受、delivery 状态 |
| 账户清理 `blocked` | 查看 cleanup 原因；解决外部未知结果后用同 operationId retry |

手动发布使用已授权的 Wrangler 环境运行 `npm run deploy`，应与 Git 集成指向同一预期 Worker。计划、配额和计费以 [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[R2](https://developers.cloudflare.com/r2/pricing/)及对应模型 / OCR / 通知供应商文档为准。本仓库不承诺固定月成本或免费额度内无限运行。
