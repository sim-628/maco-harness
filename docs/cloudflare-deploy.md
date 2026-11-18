# Cloudflare 部署与连接设置

本仓库包含 Worker、SQLite Durable Object 绑定、迁移声明、锁定依赖、测试及部署脚本。以下操作在你的 Cloudflare、Supabase、Google / Microsoft 项目中完成；仓库发布不代表这些账号已完成配置或生产部署。

## 1. 连接 GitHub

在 Cloudflare Workers 的 Git 集成中选择 [sim-628/maco-harness](https://github.com/sim-628/maco-harness)，授权该仓库访问。

| 项目 | 配置 |
| --- | --- |
| 生产分支 | `main` |
| 根目录 | `/` |
| Worker 名称 | `maco-harness` |
| Build command | `npm ci && npm test && npm run test:worker` |
| Deploy command | `npm run deploy` |
| Node 版本 | 使用 `.node-version`，或在构建配置中设置一致版本 |

Worker 名称应与 `wrangler.jsonc` 一致。配置中的 `AGENTS` 绑定、`MacoAgent` 类名与 `v1` SQLite migration 需要保留；不要为了重新部署删除 / 改名已有 DO namespace。构建失败时不会进入本次 deploy。

Cloudflare 的构建变量与 Worker 运行时变量是两套配置：**模型凭据主密钥与 OAuth 配置必须放在 Worker 的运行时 Variables and Secrets**，仅放到 Build variables 不会供线上代码读取。当前 wrangler 使用 keep_vars 保留运行时 dashboard 变量。参考 [Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) 与 [Git 集成](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/)。

## 2. 运行时配置

以 [.dev.vars.example](../.dev.vars.example) 为完整模板。不要把真实 secret 提交到 GitHub。

| 名称 | 类型 / 用途 |
| --- | --- |
| `SUPABASE_URL` | 变量；现有 Supabase 项目 HTTPS origin，不能附带任意路径 |
| `JWT_AUDIENCE` | 变量；默认 `authenticated` |
| `ALLOWED_ORIGINS` | 变量；浏览器来源精确白名单，逗号分隔，包含端口，如 `https://app.example.com,http://localhost:3000` |
| `CONNECTION_ENCRYPTION_KEY` | Secret；32 字节随机值的 base64，稳定保留 |
| `OAUTH_REDIRECT_URI` | 变量；已部署 App / 网页实际接收 OAuth 回调的 HTTPS URL |
| `GOOGLE_CLIENT_ID` | 变量或 Secret；启用 Gmail 时必需 |
| `GOOGLE_CLIENT_SECRET` | Secret；启用 Gmail 时必需 |
| `MICROSOFT_CLIENT_ID` | 变量或 Secret；启用 Outlook 时必需 |
| `MICROSOFT_CLIENT_SECRET` | Secret；启用 Outlook 时必需 |
| `MODEL_PROVIDER_HOSTS` | 可选变量；受信任兼容模型主机，逗号或空白分隔；默认不允许自定义主机 |
| `MAX_OPEN_TASKS` | 可选变量；每用户未结束 Task，默认 32，范围 1–256 |
| `MAX_PENDING_OPERATIONS` | 可选变量；每用户待处理操作，默认 256，范围 30–2048 |

生成一次加密主密钥：

```sh
openssl rand -base64 32
```

将结果保存到运行时 Secret。重启或部署时沿用；直接换值会使旧连接无法解密，需要正式密钥轮换 / 重加密迁移。不要用普通用户 token 或 Supabase service role 作为此密钥。

模型 API key 不要求作为 Worker 全局 Secret。登录用户通过 `/v1/connections/model` 创建自己的加密连接。OpenAI、Anthropic、DeepSeek 的预设 endpoint 无需 MODEL_PROVIDER_HOSTS；其他兼容供应商需显式设置真实受信任域名，不能使用通配符、IP 或内网域名。示例 `api.groq.com,api.together.xyz` 仅演示格式，实际协议与模型必须单独验收。

## 3. Supabase 身份

当前验证器支持 ES256 / RS256 非对称 JWT，并从该项目 JWKS 校验签名、issuer、audience、角色、subject 与到期时间。旧 HS256 项目不能仅填 URL 就接入，需要在认证项目迁移到支持的签名方式。

登录在原 App 完成；App 向 Worker 发 access token。Worker 不需要 service role key，也不把邮件请求绕到 Supabase。原生 App 无 Origin header 时不受浏览器跨域机制约束；浏览器 Web / OAuth 回调页的 origin 应列入 ALLOWED_ORIGINS。

## 4. Gmail / Microsoft OAuth

在需要启用的服务商项目注册 OAuth 应用与实际 HTTPS 回调 URL，并配置对应 client ID / secret。所需 OAuth scope 由用户选择的产品 actions 推导，默认只读；Google / Microsoft 的应用发布、组织策略、同意审核等需按该项目实际要求处理。

回调流程：App 调用 oauth/start → 打开 authorizationUrl → 供应商把 code / state 交给你的 HTTPS 回调页 → 已登录回调页或原 App 携带 access token POST oauth/complete。

**Worker 没有公开 GET callback 页面。** 不要把 `/v1/connections/oauth/complete` 直接作为浏览器 redirect URI。你需要复用现有 App 的安全回调页面 / 深链桥接，或部署一个小型回调页面；它只负责把 code、state 安全交还发起授权的登录用户。state 绑定用户与 PKCE，不能由另一个账号代为完成。

客户端不能把旧 OAuth refresh token 随意贴进模型 key 入口。重新授权后的 account ID、scope 和 epoch 以 ConnectionStore 结果为准；旧运行发现 epoch 变更会拒绝继续使用旧凭据。

## 5. 部署后的检查

先访问 `https://<worker-domain>/health`。健康响应只说明入口可达，不能验证 JWT、持久存储、邮箱授权或模型可用。

使用专门的测试账户依次完成：

1. App 登录后读取 connections / snapshot，检查另一个用户不可访问该账号连接或任务。
2. 创建一个实际模型连接，查询 capabilities，运行简单 Task，核对流与 usage。
3. 完成 Gmail 或 Outlook OAuth，读取组织结构、邮件与已有草稿。
4. 启动 mail.sync，观察 coverage 与游标推进，确认 fulltext / 覆盖不足会回退。
5. 对测试邮件执行可逆修改，核对服务商状态、回执和多端事件。
6. 在专门测试收件人上验证获准外发与撤销，检查批准前无派发、重试不会重复受理。
7. 保存 / 删除一条个人事实，确认跨 Task 相关历史与明确偏好；需要时启用 model_proposals 并审批一条提案。
8. 关闭客户端后重新连接，用保存的 seq 补齐事件；升级 Worker 后检查既有数据仍在。

这些是上线验收步骤，不表示仓库制作期间已在你的真实账户执行。

## 6. 本地与手动部署

```sh
npm ci
npm run check
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填本地联调需要的运行时值
npm run dev
```

本地测试不需要真实模型或邮箱账号；真实联调才需要自己的配置。OAuth 要求 HTTPS 回调，本地 HTTP `/v1/connections/oauth/complete` 不会自动成为有效公网 callback。

手动部署可使用已授权的 Wrangler 环境运行 `npm run deploy`。Git 集成部署与本地部署应指向同一预期 Worker / 环境，避免误建不同 DO 数据集。不要把生产凭据放进测试夹具或 CI 日志。

## 7. 常见故障

| 表现 | 优先核对 |
| --- | --- |
| 401 / JWT 不接受 | 项目 origin、ES256 / RS256、audience、token 到期；不是 service role / anon key |
| 浏览器 CORS 失败 | ALLOWED_ORIGINS 是否与页面 origin 完全一致，包含端口且无路径 |
| OAuth callback 404 或 401 | 是否错误注册成 Worker POST 路由；回调页是否恢复同一登录用户 |
| 自定义模型 endpoint 被拒绝 | 精确 host 白名单、HTTPS、baseUrl 根路径、无 query / hash；是否真实兼容协议 |
| 旧连接解密失败 | CONNECTION_ENCRYPTION_KEY 是否被替换或只设置在 build 环境 |
| 邮件索引不完整 | 初始回填、delta 失效、scope、rate limit、after 窗口；读取 coverage |
| operation=unknown | 在服务商核对实际结果，再人工 reconcile；不要创建新 command 盲目重发 |
| 审批版本冲突 | 重新拉取冻结预览，用最新 approvalVersion 请求用户批准 |
| 429 容量限制 | 先处理未结束任务 / 待批操作，评估后再提高准入阈值 |

Cloudflare observability 已配置采样日志与 traces，账号级 metrics 提供局部时延；生产成本和 p95 必须根据真实使用量测量。SQLite DO 的可用计划与资源限额以 [Cloudflare Durable Objects 官方文档](https://developers.cloudflare.com/durable-objects/platform/pricing/) 为准，本仓库不承诺固定月成本或免费额度内无限运行。
