# 环境变量、凭据索引与 Secrets Store

新 `maco-harness` 最少需要 `SUPABASE_URL` 和 `CONNECTION_ENCRYPTION_KEY`。**不需要 `SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_ANON_KEY` 或全局 `OPENAI_API_KEY`。** Supabase 负责登录；Worker 通过项目公开 JWKS 验证用户 JWT。各用户的模型 key、邮箱 OAuth token、MCP token 保存在自己的加密连接中，任务只引用连接 ID。

本文对应当前仓库实现。完整部署流程和各功能验收见 [Cloudflare 部署](cloudflare-deploy.md)，客户端接口见[连接协议](protocol.md#2-连接)。

## 1. 第一次部署填什么

普通变量和 Worker Secret 在 **Worker → Settings → Variables and Secrets** 设置；Secrets Store 引用在 **Bindings** 设置，并按下文写入 `wrangler.jsonc`。它们都是运行时配置。Git 构建页的 Build variables 只服务构建，不会自动成为运行时配置。

### 必需与常用变量

| 名称 | 类型 | 填写方式 |
| --- | --- | --- |
| `SUPABASE_URL` | 普通变量，必需 | 现有登录项目的 HTTPS origin，例如 `https://<project-ref>.supabase.co`；不带 `/auth/v1` 或其他路径 |
| `CONNECTION_ENCRYPTION_KEY` | Secret，必需 | 新生成一次的 32 字节随机值，经 base64 编码；后续部署保持同值 |
| `JWT_AUDIENCE` | 普通变量，可省略 | 默认 `authenticated` |
| `ALLOWED_ORIGINS` | 普通变量，Web 客户端需要 | 逗号分隔的精确网页 origin，例如 `https://app.example.com`；原生 App 无 Origin 请求可省略 |
| `MODEL_PROVIDER_HOSTS` | 普通变量，按需 | 自定义 OpenAI-compatible 连接的可信 DNS 主机列表；内置 OpenAI、Anthropic、DeepSeek 不需要 |
| `HOSTED_AGENT_ENABLED` | 普通变量，可省略 | 默认关闭；初次可明确设 `false`，启用条件见下表 |

在自己的终端生成主密钥：

```sh
openssl rand -base64 32
```

将输出保存为 `CONNECTION_ENCRYPTION_KEY` 的 Secret 值，并保留安全备份。它是本后端加密凭据的主密钥，不是模型 API key、Supabase key 或 OAuth client secret。不要每次构建重新生成。

JWT 验证器支持 Supabase ES256 / RS256 签名。仍使用旧 HS256 签名的项目，需要先按 Supabase 的签名密钥迁移流程完成配置。`AGENTS`、`NOTIFICATIONS`、`ASSETS`、`AI` 已由仓库声明为 Cloudflare 资源 binding，不应当填成字符串环境变量。

### 按启用能力增加配置

| 能力 | 普通变量 | Secret 或 Secrets Store binding |
| --- | --- | --- |
| Gmail OAuth | `OAUTH_REDIRECT_URI`、`GOOGLE_CLIENT_ID` | `GOOGLE_CLIENT_SECRET` |
| Outlook OAuth | `OAUTH_REDIRECT_URI`、`MICROSOFT_CLIENT_ID` | `MICROSOFT_CLIENT_SECRET` |
| MCP | `MCP_SERVERS`，按需 `MCP_OAUTH_REDIRECT_URI`；配置客户端的 `clientIdEnv` 对应变量 | 配置客户端的 `clientSecretEnv` 对应 Secret；动态注册凭据由用户连接保管 |
| 独立 OCR | 按需 `ASSET_AUTO_OCR=deepseek` | `DEEPSEEK_OCR_API_KEY` |
| 托管复杂任务 | `HOSTED_AGENT_ENABLED=true`、`HOSTED_AGENT_MODEL`；可选 profile / effort | `OPENAI_AGENTS_API_KEY`，由运营方账户计费 |
| APNs | `APNS_TEAM_ID`、`APNS_KEY_ID`、`APNS_TOPIC`；按需 `APNS_ENVIRONMENT` | `APNS_PRIVATE_KEY`，有效 `.p8` 私钥 |
| Gmail webhook | `GMAIL_PUBSUB_TOPIC`、`GMAIL_PUBSUB_SUBSCRIPTION`、`GMAIL_PUBSUB_AUDIENCE`、`GMAIL_PUBSUB_SERVICE_ACCOUNT` | 无额外固定 token；复用用户邮箱授权 |
| Outlook webhook | `NOTIFICATION_BASE_URL`，填新 Worker 的 HTTPS origin | 无额外固定 token；复用用户邮箱授权 |

`OAUTH_REDIRECT_URI` 是实际存在的 App / Web HTTPS 回调页面；本 Worker 没有公开 GET OAuth 回调页面。不要直接注册 POST `/v1/connections/oauth/complete` 作为浏览器回调。

`CONNECTOR_ENCRYPTION_KEY`、`NOTIFICATION_ENCRYPTION_KEY` 是可选独立加密主密钥；省略时复用 `CONNECTION_ENCRYPTION_KEY`。省略就是不配置，不能填空字符串。容量、解析和超时参数通常先使用默认值；完整模板见 [`.dev.vars.example`](../.dev.vars.example)与[部署配置](cloudflare-deploy.md#2-配置-worker-运行时变量与-secrets)。

## 2. Supabase service role 在哪里，为什么这里不填

如旧后端仍需要它，可在 **Supabase 项目 → Settings → API Keys → Legacy anon, service_role API keys** 中找到旧 `service_role`。当前 Supabase 也提供 `sb_secret_...` 服务端 secret key；它和旧 `service_role` 都属于高权限后端凭据，不应放进 App。具体界面和新旧 key 区别见 [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)。

本仓库只读取 `SUPABASE_URL`，从 `/auth/v1/.well-known/jwks.json` 获取公开验证密钥；没有 Supabase 管理 API 或数据库访问。因此新 Worker 的配置中直接省略 `SUPABASE_SERVICE_ROLE_KEY`。App 自己用于 Supabase 登录的 publishable key 属于另一处配置，不能把它当成用户登录后的 access token。

## 3. “只留索引”分成两种情况

| 凭据归属 | 保存位置 | 调用时引用 |
| --- | --- | --- |
| 每个用户自己的模型 API key | 用户 DO 中的加密连接 | `modelProfile.connectionId` |
| 每个用户的 Gmail / Outlook / MCP OAuth token | 用户 DO 中的加密连接，由后端刷新 | 邮箱 `mailboxId` / MCP `connectionId` |
| 运营方 Google / Microsoft OAuth client secret、OCR key、托管执行 key、APNs 私钥 | 普通 Worker Secret，或账户级 Cloudflare Secrets Store | 部署端固定 binding，对应 `store_id + secret_name` |
| 数据加密主密钥 | 普通 Worker Secret，或固定版本的 Secrets Store secret | 固定 `CONNECTION_ENCRYPTION_KEY` 等 binding；值不能自动更换 |

用户模型 key 只需在 `POST /v1/connections/model` 创建或更新连接时提交。后续 Task 保留 `provider / model / effort / connectionId`。更换该用户的 key 使用 `id + expectedEpoch` 更新连接，epoch 随之增加；旧任务不能绕过版本检查继续执行。这样不需要给每个用户增加一个 Worker 环境变量，也不会把连接 ID 作为公开取密接口。

Secrets Store 当前公开 beta 的限制是每账户一个 store、最多 100 个生产 secrets，单值最多 65,536 字节，适合少量运营方凭据。它不取代大量用户凭据的加密数据库。限制以 [Cloudflare Manage account secrets](https://developers.cloudflare.com/secrets-store/manage-secrets/) 为准。

## 4. 运营方 key 如何改成 Secrets Store 引用

代码接受两种来源：普通 Worker Secret 的字符串，或原生 Secrets Store binding。两种来源使用相同变量名；只在相应能力实际调用时读取，不会先读取整套 secrets。模型用户连接仍走上一节的加密连接协议。

### 建立稳定引用

1. 在 Cloudflare 账户的 **Secrets Store** 中创建 secret，赋予 `workers` scope，把真实值保存在那里。选用能表达服务与账户用途的稳定名字，例如 `maco-google-oauth-client-secret`；不在名称里放 key 本身。
2. 记录 **Store ID** 和 **Secret name**。这些是配置引用，不是秘密值。
3. 把下列条目合并进仓库现有 `wrangler.jsonc` 的顶层。只添加实际启用且已创建的 secret，替换 `YOUR_STORE_ID`，保留已有 DO migrations、R2、AI 和其他配置。

```jsonc
{
  "secrets_store_secrets": [
    {
      "binding": "GOOGLE_CLIENT_SECRET",
      "store_id": "YOUR_STORE_ID",
      "secret_name": "maco-google-oauth-client-secret"
    },
    {
      "binding": "OPENAI_AGENTS_API_KEY",
      "store_id": "YOUR_STORE_ID",
      "secret_name": "maco-openai-agents"
    }
  ]
}
```

上例是要合并的配置片段，不是整个 `wrangler.jsonc`。`binding` 必须与代码读取的变量名一致；同一变量只选择一种来源，不同时保留同名普通 Secret 和 Secrets Store binding。将真实 binding 元数据随 Git 部署，秘密值仍只保存在 Secrets Store。部署身份还需要绑定对应 secret 的权限。

若通过 Dashboard 配置：进入 **Worker → Settings → Bindings → Add → Secrets Store**，Variable name 填代码变量名，Secret name 选择账户中的实际 secret。**随后也要把这份 binding 元数据写入仓库。** 本仓库的 Git 部署以 `wrangler.jsonc` 为资源配置来源，Dashboard-only binding 不能依靠 `keep_vars:true` 保留：该选项仅保留普通变量；普通 Worker Secrets 的自动保留也不等于 Secrets Store binding 的自动保留。参考 [Workers 集成](https://developers.cloudflare.com/secrets-store/integrations/workers/)与 [Wrangler 配置来源](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)。

实际代码通过 `await env.GOOGLE_CLIENT_SECRET.get()` 一类原生 binding 读取。`.get()` 没有用于任意 secret 名称的参数；也不能把 `maco-google-oauth-client-secret` 当成普通 `GOOGLE_CLIENT_SECRET` 的值，期待代码自动查找。Secrets Store 管理 API 和 Dashboard 不能在创建后读回明文；读取由获准绑定该 secret 的服务完成，无需另建一个取密代理服务。

### 更新后如何生效

运营方供应商凭据更新时，在同一个 Secrets Store secret 下更改值，保持 binding 引用稳定。应用后续使用时重新读取平台当前提供的值，不在 DO 中长期缓存这些原始供应商 key，也不在取密失败时静默使用旧值。已有请求不会被改写；此机制不承诺全球瞬时生效，也不会自动向供应商申请或续期新 API key。

轮换需保持其身份和授权用途一致。托管执行已创建的任务和文件仍属于原供应商项目，换成其他项目的 key 不会迁移这些资源。OAuth client secret 更换应保持原 client ID；更换 client ID 或 issuer 需要重新授权。APNs 更换签名 key 时，还需同步匹配的 `APNS_KEY_ID`，缓存 JWT 会按当前签名配置重新生成。

MCP 的运营方预配置客户端保存受控 `clientSecretEnv` 引用，在兑换 code / 刷新 token 时解析当前 secret；不是把运营方 client secret 固化到每个用户 grant。动态注册返回的每用户 client secret 则仍加密保存在用户连接中。

## 5. 主加密 key 保持固定版本

初次部署可直接将 `CONNECTION_ENCRYPTION_KEY` 保存为普通 Worker Secret。若统一放进 Secrets Store，建议使用 `maco-vault-master-v1` 这样的固定版本名，并保持对应值不变。代码第一次成功使用时导入该主密钥；它不作为跟随“最新值”的供应商凭据。

现有密文没有多版本 keyring。直接替换主密钥会导致已存模型 key、OAuth token、设备信息或缓存无法解密；不同存活实例也可能持有不同的主密钥。正确轮换需要另做带版本密文、保留旧解密 key、后台重加密和旧 key 退役迁移。这也适用于可选的 `CONNECTOR_ENCRYPTION_KEY` 与 `NOTIFICATION_ENCRYPTION_KEY`。

## 6. 本地与部署核对

本地普通字符串配置继续使用未提交的 `.dev.vars`。测试 Secrets Store binding 时，按官方 Wrangler Secrets Store 命令创建本地测试值；本地开发不能读取生产 secrets，本地 Secrets Store 数据也没有生产加密保护。不要把真实生产秘密写进示例文件或 `.wrangler/state`。

部署后按实际启用功能检查状态和测试账户调用。状态接口只表示配置存在，不会预取所有 secrets 来证明外部服务可用；错误 secret、权限不足或 provider 拒绝应在相应能力的调用中排查。更改绑定后，再做一次 Git 构建部署并确认绑定仍存在，避免配置只停留在 Dashboard 的临时版本中。

参考：[Secrets Store Workers integration](https://developers.cloudflare.com/secrets-store/integrations/workers/)、[Manage account secrets](https://developers.cloudflare.com/secrets-store/manage-secrets/)、[Wrangler Secrets Store commands](https://developers.cloudflare.com/workers/wrangler/commands/secrets-store/)、[Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)。
