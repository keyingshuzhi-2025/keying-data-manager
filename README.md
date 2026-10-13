# 文件共享站（Local File Hub）

一个面向局域网、也可经 HTTPS 反向代理安全部署到公网的轻量文件共享平台。用户可以通过浏览器上传、浏览、搜索、预览、下载和管理文档、图片、音频、视频及其他普通文件，也可以将 Web 应用安装为 PWA。

文件内容保存在服务器本地对象目录中，SQLite 只保存用户、会话、文件元数据、文件/文件夹权限、分享链接、站点配置、邀请码和活动日志，不保存文件 BLOB。项目不依赖云服务、对象存储、消息队列或外部 API。

> **版本基线**：当前项目版本为 `0.1.3`。本版本正式发布文件与文件夹 ACL、公开分享、动态水印、安全加固、审计与备份等能力。npm 包尚未发布。版本状态见 [`VERSION.md`](VERSION.md)。

## 当前状态

当前 `0.1.3` 版本已经实现：

- 注册、登录、会话管理和密码修改；登录/注册/改密/重置密码限流（429）；
- 管理员账号、普通用户、用户启用/停用和**文件/文件夹六维权限**（读取/下载/上传/编辑/MD 编辑/分享）；
- 用户创建、删除、批量启用/停用/删除、密码重置、角色变更、**存储配额配置**；
- 一次性邀请链接，注册时自动授予邀请中预设的权限；可关闭开放注册、仅邀请码注册；
- **条目级继承权限（ACL）**：管理员可指定员工管理权限，并按员工为文件/文件夹单独设置六项权限；未单独设置时沿目录链继承，管理员全权绕过；
- **公开分享链接**（匿名 · 限时 · 只读 · 可撤销）：时效档位、次数上限、访问密码、文件夹分享隔离；
- **动态防泄密水印**：图像预览/下载叠加身份水印，分享输出叠加分享者+短码溯源水印，管理员可配置；
- **MD 在线编辑与导出 PDF**：每页叠加身份水印（markdown-it + pdf-lib，无 puppeteer）；
- 文件上传、目录浏览、搜索、筛选、排序、分页、预览、下载、重命名、移动、复制和删除；
- **上传白名单**：可执行/脚本/HTML 等高风险扩展名 415 拒绝；
- 图片、音频、视频、PDF 和纯文本的浏览器预览；图像预览/下载均走服务端水印；
- HTTP Range 流式传输和 `206 Partial Content`；
- SQLite 元数据、WAL、外键和 schema 迁移（`user_version` 8）；
- 本地对象存储、临时上传清理和孤立对象清理；
- **全局活动审计**（含 CSV 导出）与按用户活动日志；
- **内置备份脚本** `npm run backup`（SQLite 在线一致性备份 + 对象归档，保留最近 7 份）；
- 响应式 React 前端、TanStack Query 状态管理和生产环境 PWA Service Worker；
- 后端单元测试、数据库迁移测试、配置测试和 API 集成测试（Node 22 / Node 24 双环境全绿）。

当前版本**尚未实现**：

- 分片上传、断点续传和上传任务持久化；
- 缩略图生成、音视频转码和媒体工作流；
- 文件离线收藏和受保护文件缓存；
- 多人实时协同编辑（当前 MD 编辑为单用户会话编辑）。

## 核心目标

- 在局域网内集中保存和共享文件。
- 支持文档、图片、音频、视频和其他普通文件。
- 提供可安装、响应式的 PWA Web 界面。
- 使用 SQLite 管理元数据，使用服务器本地目录保存二进制内容。
- 保持单节点部署简单，可在 Linux 服务器、NAS 或高性能工作站上运行。
- 默认同站同源部署，不引入额外的前端服务器或 CORS 配置。

## 明确不在当前范围内

- AI 知识库、向量检索和自动内容总结。
- 公有云同步和跨地域分发。
- 多人实时协同编辑。
- 在线音视频转码和复杂媒体工作流。
- 分布式文件系统。
- 将大体积媒体文件默认缓存到浏览器离线使用。

## 技术架构

项目采用前后端分离的单仓库架构。开发环境分别运行 Vite 和 Fastify；生产环境由同一个 Node.js 服务提供 API 和前端静态资源。

```text
Browser / PWA
      |
      | HTTP + JSON / multipart / Range
      v
+-----------------------------+
| Node.js + Fastify           |
| API / Auth / Stream / Static|
+--------------+--------------+
               |
               +--------------> SQLite（元数据）
               |
               +--------------> 本地对象存储目录（文件内容）
               |
               +--------------> dist/web（生产前端）
```

### 前端

- **React 19**：组件化构建文件列表、上传界面、预览界面和管理界面。
- **Vite 8**：开发服务器和生产构建。
- **TypeScript 7**：约束前端业务模型和 API 数据类型。
- **TanStack Query 5**：处理文件列表、会话、管理数据和请求状态。
- **原生 CSS + CSS Variables**：响应式布局，不引入大型 UI 框架。
- **Lucide React**：界面图标。
- **vite-plugin-pwa / Workbox**：生成 Manifest、图标和 Service Worker。

前端不直接访问 SQLite 或服务器文件系统，所有数据操作都通过同源后端 API 完成。

### 后端

- **Node.js 22.12+**：统一运行环境；Docker 镜像使用 Node.js 24。
- **Fastify 5**：REST API、multipart 上传和文件流处理。
- **TypeScript**：服务端类型定义和接口校验。
- **better-sqlite3**：本地单节点 SQLite 访问。
- **Zod**：配置、请求参数和业务输入校验。
- **Node.js `crypto`**：UUID、SHA-256、加盐 scrypt 密码哈希和会话令牌哈希。
- **pino**：结构化运行日志。
- **@fastify/cookie、@fastify/multipart、@fastify/static**：Cookie、上传和静态资源插件。

## 目录设计

```text
.
├── package.json                 # 依赖与统一脚本
├── package-lock.json            # 锁定依赖版本
├── VERSION.md                   # 当前文档同步版本基线
├── .env.example                 # 环境变量示例
├── README.md
├── Dockerfile
├── docker-compose.yml
├── scripts
│   ├── backup.ts                # SQLite 在线备份 + 对象归档
│   ├── dev-fetch-prebuilt.mjs   # 开发环境原生模块预编译包下载辅助
│   └── dev-list-prebuilt.mjs    # 开发环境原生模块资产查询辅助
├── vitest.config.ts
├── apps
│   ├── web
│   │   ├── public               # PWA 图标和资源
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── src
│   │       ├── api              # API 客户端和上传请求
│   │       ├── components       # 通用组件
│   │       ├── features
│   │       │   ├── admin        # 用户、权限、邀请码和活动
│   │       │   ├── auth         # 登录、注册和修改密码
│   │       │   └── files        # 文件列表、上传、预览和管理
│   │       ├── hooks
│   │       ├── styles
│   │       └── utils
│   └── server
│       ├── src
│       │   ├── db               # SQLite schema 和迁移
│       │   ├── routes           # 认证、管理员和文件路由
│       │   ├── activity-log.ts
│       │   ├── auth.ts
│       │   ├── config.ts
│       │   ├── file-service.ts
│       │   ├── storage.ts
│       │   └── types.ts
│       └── test                 # 单元、迁移和 API 集成测试
└── data                         # 本地运行数据，默认被 Git 忽略
    ├── db
    ├── objects
    └── uploads
```

`data/` 仅用于本地运行。生产环境应通过环境变量将数据库和对象存储指向独立磁盘，例如 `/srv/local-file-hub/data`，不要与代码目录混用。

## 数据模型

SQLite 只保存文件元数据，不保存文件内容。当前 schema 版本为 `user_version = 8`（数据库结构版本，与项目版本 `0.1.3` 分开管理），启动时会对旧版本表执行增量迁移。v0.1.2 引入 `folder_permissions`（ROOT/兼容 ACL）、`item_permissions`（员工与具体文件/文件夹 ACL）、`shares`（公开分享）和 `app_config`（站点配置，如水印参数）。

### `users`

| 字段 | 说明 |
|---|---|
| `id` | 用户 UUID/随机 ID |
| `username` | 登录名，唯一且大小写不敏感 |
| `password_hash` | `scrypt$salt$hash` 加盐密码哈希 |
| `role` | `admin` 或 `user` |
| `is_enabled` | 账号是否启用；停用后立即无法登录 |
| `can_read` | 遗留全局权限列；未命中文件夹 ACL 时作为 `read` 基线 |
| `can_upload` | 遗留全局权限列；未命中文件夹 ACL 时作为 `upload` 基线 |
| `can_edit` | 遗留全局权限列；未命中文件夹 ACL 时作为 `edit` 基线 |
| `can_manage_permissions` | 管理员指定的条目权限管理能力 |
| `storage_quota_bytes` | 非管理员上传配额，`0` 表示不限制 |
| `created_at` | 创建时间 |
| `last_login_at` | 最近登录时间 |

首次启动时会根据 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 创建管理员。若同名管理员已经存在，启动逻辑会确保其角色启用并拥有全部权限，但不会用环境变量覆盖已有密码。管理员始终拥有全部文件权限，管理员账号的权限不能通过普通权限接口修改。

普通用户注册后默认没有任何文件权限。v0.1.2 的生效权限是六维模型：`read`（浏览/预览）、`download`（下载/流式）、`upload`（上传/新建目录）、`edit`（重命名/移动/复制/删除）、`editMd`（在线编辑 Markdown）和 `share`（创建分享链接）。具体员工与文件/文件夹的单独授权优先生效；未单独授权时继承最近的上级条目 ACL，再回退到 ROOT 默认策略与账号基线。管理员界面在关闭读取权限时会同步关闭上传和编辑权限，以保持权限集合一致。

### `sessions`

| 字段 | 说明 |
|---|---|
| `token_hash` | 会话令牌的 SHA-256，数据库不保存原始令牌 |
| `user_id` | 关联用户 |
| `ip` | 登录时的客户端 IP（最多 100 字符） |
| `user_agent` | 登录时的 User-Agent（最多 300 字符） |
| `expires_at` | 会话过期时间 |
| `created_at` | 会话创建时间 |

会话通过名为 `lfh_session` 的 Cookie 传递，Cookie 使用 `HttpOnly`、`SameSite=Strict`，生产环境默认启用 `Secure`。启动时会清理过期会话；停用/删除用户、管理员重置用户密码或用户修改密码时，会使相关会话失效。

### `files`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT | 文件/目录 UUID |
| `parent_id` | TEXT | 父目录 ID；根目录为空 |
| `name` | TEXT | 用户看到的文件名 |
| `kind` | TEXT | `file` 或 `folder` |
| `object_id` | TEXT | 本地对象标识；目录为空 |
| `mime_type` | TEXT | MIME 类型 |
| `extension` | TEXT | 小写扩展名 |
| `size_bytes` | INTEGER | 文件字节数；目录通常为 `0` |
| `sha256` | TEXT | 完整文件 SHA-256 |
| `uploaded_by` | TEXT | 上传用户 ID；复制文件当前不会重新归属上传者 |
| `is_shared` | INTEGER | 是否曾创建分享链接（创建分享时置 1） |
| `created_at` | TEXT | ISO-8601 创建时间 |
| `updated_at` | TEXT | ISO-8601 更新时间 |
| `deleted_at` | TEXT | 软删除时间；为空表示有效 |

主要索引包括：

- `files(parent_id, deleted_at, created_at)`
- `files(name COLLATE NOCASE, deleted_at)`
- `files(mime_type, deleted_at)`
- `files(size_bytes, deleted_at)`
- `files(COALESCE(parent_id, ''), name COLLATE NOCASE)` 的有效同名唯一索引

目录使用 `files` 表自关联表示，根目录是虚拟节点。删除目录时，只要存在直接子项就会拒绝删除；文件删除采用软删除。对象文件在没有任何有效文件记录引用时会被清理。

### `invites`

| 字段 | 说明 |
|---|---|
| `id` | 邀请记录 ID |
| `code` | 一次性邀请码 |
| `can_read` / `can_upload` / `can_edit` | 注册成功后授予的权限 |
| `is_enabled` | 邀请是否可用 |
| `created_by` | 创建邀请的管理员 |
| `expires_at` | 可选过期时间 |
| `used_by` / `used_at` | 使用邀请的用户和时间 |

邀请码只能使用一次。邀请链接的格式为 `/register?invite=<code>`；邀请过期、停用或已使用后会拒绝注册。当前不会发送邮件或短信，管理员需要自行复制和分发链接。

### `folder_permissions`

| 字段 | 说明 |
|---|---|
| `folder_id` | 文件夹 ID；`ROOT` 表示可选的根目录默认策略 |
| `can_read` / `can_download` / `can_upload` | 读取、下载、上传权限 |
| `can_edit` / `can_edit_md` / `can_share` | 编辑、Markdown 编辑、分享权限 |
| `updated_by` / `updated_at` | 最后修改者与时间 |

ACL 沿目录链自近向远取最近显式策略；未配置时回退用户全局权限。管理员全权绕过 ACL。

员工与具体文件/文件夹的单独授权保存在 `item_permissions`，优先于共享目录 ACL，并沿文件夹树继承。管理员可在用户管理中授予员工权限管理能力；获授权员工可从文件/文件夹卡片配置员工 ACL。

### `item_permissions`

| 字段 | 说明 |
|---|---|
| `item_id` / `user_id` | 文件或文件夹与被授权员工的组合键 |
| 六项 `can_*` | 读取、下载、上传、编辑、Markdown 编辑、分享 |
| `updated_by` / `updated_at` | 最后修改者与时间 |

### `shares`

| 字段 | 说明 |
|---|---|
| `id` | 分享记录 ID |
| `token_hash` | 分享令牌的 SHA-256，数据库不保存明文令牌 |
| `file_id` / `kind` | 分享根文件或目录 |
| `created_by` | 创建者 |
| `expires_at` | 可选过期时间 |
| `max_accesses` / `access_count` | 访问次数上限与已用次数 |
| `password_hash` | 可选访问密码哈希 |
| `is_revoked` | 是否撤销 |
| `created_at` / `last_access_at` | 创建与最近访问时间 |

公开端点每次访问都会校验“存在、未撤销、未过期、次数未用尽、密码正确”五要素；文件夹分享只允许访问根目录子树内文件。

### `app_config`

| 字段 | 说明 |
|---|---|
| `key` | 配置键；水印配置使用 `watermark_config` |
| `value` | JSON 字符串 |
| `updated_by` / `updated_at` | 修改者与时间 |

### `activity_logs`

| 字段 | 说明 |
|---|---|
| `id` | 日志 ID |
| `user_id` | 执行操作的用户 |
| `action` | 登录、注册、上传、下载、文件变更、用户管理、邀请等操作 |
| `target_type` / `target_name` | 操作目标 |
| `detail` | 可选详情 |
| `created_at` | 操作时间 |

活动日志采用尽力写入，记录失败不会阻断主业务。管理员可以在用户详情中查看该用户最近 50 条活动；v0.1.2 还提供全站活动审计页面，支持动作、用户、时间和关键词筛选，并可导出 CSV。

## 文件存储设计

实际内容存放在：

```text
data/objects/<UUID前两位>/<完整UUID>.blob
```

示例：

```text
data/objects/ab/abcd1234-....blob
```

存储规则：

1. 上传内容先进入 `data/uploads/` 下的临时文件。
2. 流式写入时计算文件大小和 SHA-256，并执行单文件大小限制。
3. 完成后通过原子重命名写入 `data/objects/`。
4. 文件落盘成功后，再在 SQLite 中写入元数据。
5. 元数据写入失败或配额不足时，清理已经暂存的对象。
6. 删除文件时先软删除；若对象不再被任何有效文件引用，则立即删除对象。
7. 服务启动时清理遗留的 `.upload` 临时文件和未被元数据引用的 `.blob` 对象。
8. API 返回文件 ID 和元数据，不暴露服务器绝对路径。

复制文件/目录时只创建新的元数据记录并共享原对象，不会复制二进制内容。当前配额统计按 `uploaded_by` 的未删除文件计算，因此复制产生的记录不会计入复制者的上传配额。

## API 设计

API 前缀为 `/api`。普通请求和响应使用 JSON；上传使用 `multipart/form-data`；下载和媒体播放使用 HTTP Range 流式响应。

错误响应统一为：

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "请求参数无效",
    "details": {}
  }
}
```

### 健康检查

```text
GET /api/health
```

健康检查不需要登录，Docker healthcheck 使用此接口。

### 认证

```text
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
POST /api/auth/password
GET  /api/auth/session
GET  /api/auth/me
GET  /api/auth/ping
```

- 注册用户名至少 3 个字符、最多 50 个字符；密码至少 8 个字符。
- 登录用户名最多 100 个字符，密码最多 1024 个字符。
- 注册成功会创建会话并自动登录。
- 修改密码要求提供当前密码，新密码不能与当前密码相同，并会使其他设备的会话失效。
- `session` 用于前端启动时恢复登录状态；`me` 和 `ping` 需要有效会话。

### 管理员用户接口

以下接口需要管理员权限：

```text
GET    /api/admin/users
POST   /api/admin/users
PATCH  /api/admin/users/:id
DELETE /api/admin/users/:id
POST   /api/admin/users/:id/reset-password
GET    /api/admin/users/:id
GET    /api/admin/users/:id/activity
POST   /api/admin/users/batch
PATCH  /api/admin/users/:id/role
```

管理员可以：

- 创建普通用户并设置启用状态、遗留全局读取/上传/编辑权限和存储配额；六维生效权限通过文件夹 ACL 管理；
- 启用/停用用户，停用会删除该用户的会话；
- 删除普通用户，不能删除管理员或当前登录用户；
- 重置普通用户密码并使该用户会话失效；
- 查看用户详情、活跃会话数、全局文件统计和最近活动；
- 批量启用、停用或删除普通用户；
- 变更普通用户角色。提升为管理员会启用账号并授予全部权限；降级保留原有权限值；不能修改自己的角色，也不能删除最后一个管理员；
- 通过 `PATCH /api/admin/users/:id` 设置 `storage_quota_bytes`，超出配额的上传返回 `409 CONFLICT`。

### 文件和文件夹权限（ACL）

以下 ACL 管理接口需要管理员或管理员指定的权限管理员身份：

```text
GET /api/permissions/acl-users
GET /api/admin/permissions?itemId=<条目ID>&userId=<员工ID>
PUT /api/admin/permissions
```

`PUT` 请求体使用 `itemId`、`userId`、`permissions`；指定 `inheritParent=true` 可清除此员工在当前条目上的规则并恢复继承。ROOT 是全局默认策略，不通过条目授权接口修改。

### 活动审计

以下接口需要管理员权限：

```text
GET /api/admin/activity
GET /api/admin/activity/export
```

`GET /api/admin/activity` 支持 `userId`、`action`、`q`、`from`、`to`、`page`、`limit` 筛选；`export` 返回 UTF-8 CSV。审计动作覆盖登录、注册、上传、下载、MD 编辑/导出、权限变更、配额变更、分享创建/访问/下载/撤销和水印配置变更。

### 水印配置

以下接口需要管理员权限：

```text
GET /api/admin/watermark-config
PUT /api/admin/watermark-config
```

配置写入 `app_config`，每次输出实时读取，变更无需重启。字段包括 `enabled`、`text`、`opacity`、`position`、`corner`、`margin`、`fontSize`、`color`、`angleDeg`、`tileWidth`、`tileHeight`、`tileSpacing`、`applyToPreview`、`applyToDownload`。

### 邀请接口

以下接口需要管理员权限：

```text
POST   /api/admin/invites
GET    /api/admin/invites
DELETE /api/admin/invites/:id
```

创建邀请时可以设置读取、上传、编辑权限和可选的过期时间（1 小时至 365 天）。撤销邀请只会使邀请失效，不会删除已经通过邀请注册的用户。

### 公开分享链接

以下接口需要登录；创建分享还要求用户对目标文件/目录具备 `share` 权限，管理员全权绕过：

```text
POST   /api/share-links
GET    /api/share-links
GET    /api/share-links/:id
PATCH  /api/share-links/:id
POST   /api/share-links/:id/revoke
DELETE /api/share-links/:id
```

创建请求包含 `fileId`、`expiresIn`（`1h` / `1d` / `3d` / `7d` / `30d` / `forever`）、可选 `maxAccesses` 和 `password`。服务端只返回一次原始令牌，数据库仅保存 SHA-256。

公开端点无需登录：

```text
GET  /api/public/shares/:token/info
GET  /api/public/shares/:token/tree
GET  /api/public/shares/:token/files/:fileId/content
POST /api/public/shares/:token/verify
GET  /api/public/shares/:token/download
GET  /api/public/shares/:token/stream
```

每次访问校验分享存在、未撤销、未过期、次数未用尽和密码正确；通过后自增 `access_count` 并写入 `share_access` / `share_download` 审计。文件夹分享严格限制在根目录子树内。

### 文件和目录接口

```text
GET    /api/files
POST   /api/files
GET    /api/files/:id
GET    /api/files/:id/path
PATCH  /api/files/:id
POST   /api/files/:id/move
POST   /api/files/:id/copy
DELETE /api/files/:id
GET    /api/files/:id/content
GET    /api/files/:id/preview
PUT    /api/files/:id/content
GET    /api/files/:id/export-pdf
```

权限要求：

- 列表、详情、路径、内容、预览：`read`
- 新建目录：`upload`
- 重命名、移动、复制、删除：`edit`
- 在线编辑 Markdown 内容：`editMd`（仅 `.md` / `.markdown`）
- 创建分享链接：`share`
- 下载、流式播放、导出 PDF：`read` + `download`

`GET /api/files` 支持：

- `parentId`：浏览指定目录；为空时浏览根目录；
- `q`：在当前目录按文件名搜索，不是递归全局搜索；
- `type`：`folder`、`image`、`audio`、`video`、`document` 或 `other`；
- `sort`：`name`、`size`、`createdAt` 或 `updatedAt`；
- `order`：`asc` 或 `desc`；
- `page` / `limit`：分页，`limit` 最大 200，前端默认每页 100。

`PUT /api/files/:id/content` 保存 Markdown 文本并记录 `md_edit` 审计；`GET /api/files/:id/export-pdf` 将 Markdown 渲染为带身份水印的 PDF 附件，使用 `markdown-it` + `pdf-lib`，不依赖 Chromium/puppeteer。

### 上传

```text
POST /api/uploads
```

请求使用 `multipart/form-data`，包含：

- `file`：单个文件；
- `parentId`：可选目标目录 UUID；
- `name`：可选期望文件名；未提供时使用上传文件名。

每个请求只能上传一个文件。后端根据扩展名优先确定 MIME 类型，客户端声明的 MIME 仅作为回退；无法识别类型、超过限制或命中禁用扩展名时会拒绝请求。上传完成后返回文件元数据。

v0.1.2 默认启用上传白名单：`.exe`、`.bat`、`.cmd`、`.sh`、`.html`、`.js`、`.ps1` 等可执行、脚本和 HTML 类型返回 `415 UNSUPPORTED_MEDIA_TYPE`；文本、文档、图片、音频、视频和归档类型允许上传。

当前不支持分片、断点续传或后台任务持久化。前端提供上传队列、进度显示和失败重试，重试会重新发起完整文件上传。

### 非管理员配额

上传接口对非管理员执行配额校验：

```text
已使用字节数 = 该用户 uploaded_by 的未删除文件 size_bytes 总和
```

`storage_quota_bytes = 0` 表示不限制；管理员不受配额限制。超出配额时返回 `409 CONFLICT`，并清理已经写入的临时对象。管理员可通过 `PATCH /api/admin/users/:id` 设置配额，前端用户管理界面提供配额输入、已用空间和保存反馈。

### 下载和媒体流

```text
GET /api/files/:id/download
GET /api/files/:id/stream
```

两个接口都要求 `read` + `download` 权限。非图像文件支持 `Range`：

- 无 Range 时返回完整内容；
- 有效 Range 返回 `206 Partial Content`、`Content-Range` 和对应 `Content-Length`；
- 无效 Range 返回 `400` 或 `416`；
- 响应包含 `Accept-Ranges`。

图像预览和下载由服务端叠加动态身份水印；水印版为完整 `200` 响应，不走原始字节 Range。`download` 强制以附件形式下载。`stream` 对安全内联类型使用 `inline`，支持：

- 非 SVG 图片；
- 音频；
- 视频；
- PDF；
- `text/plain`。

其他类型以下载附件形式返回，避免浏览器内联执行潜在不安全内容。

## PWA 设计

PWA 用于安装应用和缓存应用壳，不表示默认离线保存文件内容。

### 可安装

- Manifest 包含名称、短名称、启动地址、显示模式、主题色和语言。
- 提供 SVG、192×192 和 512×512 图标，以及 maskable 图标。
- 生产构建注册 Service Worker；开发模式关闭 Service Worker，避免与 Vite HMR 冲突。

### Service Worker 缓存

默认缓存：

- HTML、JavaScript、CSS、SVG 和 PNG 等应用壳资源；
- `index.html`、Manifest 和 Service Worker 使用 `no-cache`，带哈希的静态资源使用长缓存。

默认不缓存：

- `/api/*` 请求；
- 登录信息、用户权限和文件元数据；
- 上传、下载和媒体流响应；
- 大体积图片、音频和视频文件。

因此网络断开时，已安装的应用壳可能仍可打开，但文件目录和文件内容不会离线可用。

## 安全与可靠性

即使只在局域网运行，也不应把服务视为完全可信环境。

- 文件 API 默认要求登录，健康检查接口除外。
- 所有文件操作都在服务端校验会话和对应权限，前端隐藏按钮不是唯一防线。
- 上传文件名禁止路径分隔符、控制字符、`.`、`..` 和过长名称；扩展名白名单优先于客户端 MIME。
- 后端自行拼接对象路径，不接受客户端提供的服务器绝对路径。
- MIME 类型优先根据扩展名判断，客户端声明类型只作为回退。
- 下载和流式接口只接受数据库中的文件 ID。
- 会话令牌只保存哈希值；Cookie 使用 `HttpOnly`、`SameSite=Strict`。
- 生产环境默认启用安全 Cookie、CSP 和 HSTS；基础安全响应头（`X-Frame-Options: SAMEORIGIN`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Permissions-Policy`）在所有环境启用。可通过 `TRUST_PROXY` 处理反向代理。
- 登录、注册、修改密码和重置密码按 IP/用户名限流，超限返回 `429 TOO_MANY_REQUESTS` 并设置 `Retry-After`。
- `REGISTRATION_ENABLED=false` 时仅允许管理员分发的邀请码注册。
- 单文件大小、multipart 文件数量、字段大小和请求体大小均有限制。
- SQLite 启用外键、WAL、`synchronous=NORMAL` 和 `busy_timeout=5000`。
- 文件写入和元数据写入采用“先落盘、后提交”的恢复策略；启动时清理临时文件和孤立对象。
- 活动日志记录失败不会阻断文件操作。
- 服务默认监听 `0.0.0.0`，部署时应通过防火墙、反向代理或网络隔离限制访问，不应直接暴露到公网。

## 配置

应用通过环境变量加载配置，Zod 会在启动时校验类型和范围。完整示例见 [`.env.example`](.env.example)。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `NODE_ENV` | `development` | `development`、`production` 或 `test` |
| `HOST` | `0.0.0.0` | HTTP 监听地址 |
| `PORT` | `3000` | HTTP 端口，范围 1–65535 |
| `DATA_DIR` | `./data` | 数据库、对象和临时上传目录的根目录 |
| `DB_PATH` | `${DATA_DIR}/db/local-file-hub.sqlite` | SQLite 文件路径 |
| `OBJECT_DIR` | `${DATA_DIR}/objects` | 文件内容目录 |
| `UPLOAD_DIR` | `${DATA_DIR}/uploads` | 未完成上传临时目录 |
| `WEB_DIST_DIR` | `dist/web` | 生产前端构建目录 |
| `PUBLIC_URL` | 未设置 | 公开分享链接的外部访问 URL；未设置时 API 返回相对路径 `/s/<token>` |
| `ADMIN_USERNAME` | `admin`（仅开发） | 首次启动的管理员账号；生产环境必须显式设置 |
| `ADMIN_PASSWORD` | `admin123`（仅开发） | 首次启动的管理员密码；生产环境至少 12 字节 |
| `MAX_UPLOAD_BYTES` | `1073741824` | 单文件上传上限，默认 1 GiB |
| `SESSION_TTL_HOURS` | `24` | 会话有效期 |
| `COOKIE_SECURE` | 生产为 `true`，开发为 `false` | 是否启用 Secure Cookie |
| `TRUST_PROXY` | `false` | `false`、`true`、代理跳数或 Fastify 支持的字符串值 |
| `LOG_LEVEL` | `info` | `fatal`、`error`、`warn`、`info`、`debug`、`trace` 或 `silent` |
| `LOG_FILE` | 未设置 | 可选 pino 日志文件路径，会自动创建父目录 |
| `RATE_LIMIT_ENABLED` | 生产为 `true`，开发/测试为 `false` | 登录、注册、改密、重置密码限流开关 |
| `RATE_LIMIT_MAX` | `5` | 单个限流窗口内允许的最大尝试次数 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 限流窗口长度（毫秒） |
| `REGISTRATION_ENABLED` | `true` | 是否开放自助注册；`false` 时仅邀请码可注册 |
| `BACKUP_DIR` | `./backups` | `npm run backup` 的备份根目录，默认保留最近 7 份 |

生产环境必须显式设置 `NODE_ENV=production`、`ADMIN_USERNAME` 和至少 12 字节的 `ADMIN_PASSWORD`。修改已有管理员的环境变量不会覆盖数据库中已有账号的密码。

## 本地开发

### 环境要求

- Node.js 22.12 或更高版本；Docker 镜像使用 Node.js 24。
- 支持 `better-sqlite3` 原生模块的 Linux、macOS 或 Windows 环境。
- npm 版本应能读取 `package-lock.json` v3。

### 安装

```bash
npm install
```

### 启动开发环境

```bash
npm run dev
```

该命令同时启动：

- Fastify API 服务，默认 `http://127.0.0.1:3000`；
- Vite 前端开发服务器，默认 `http://127.0.0.1:5173`。

开发环境下，Vite 通过代理将 `/api` 请求转发到后端。也可以分别启动：

```bash
npm run dev:web
npm run dev:server
```

### 类型检查和测试

```bash
npm run typecheck
npm test
```

测试覆盖服务端配置、数据库迁移、文件服务、ACL 权限矩阵、分享五要素、动态水印、上传白名单、只读不可下载、限流、配额、审计、备份脚本、API 集成流程以及前端格式化函数；v0.1.2 已在 Node.js 22 和 Node.js 24 环境分别验证 typecheck 与完整测试套件。

### 构建和运行生产版本

```bash
npm run build
NODE_ENV=production \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD='请替换为至少12位的强密码' \
npm run start
```

构建产物：

- 后端：`dist/apps/server/src/index.js`
- 前端：`dist/web/`

生产服务默认访问 `http://localhost:3000`。`npm run start` 只启动已构建的 Node.js 服务，不会自动执行前端构建。

## 生产部署

### 手动部署

推荐：

- Ubuntu Server 22.04/24.04 LTS；
- Node.js 22.12+ LTS；
- 独立数据盘或 RAID 卷；
- Nginx/Caddy 反向代理（可选）；
- systemd 或其他进程守护；
- 仅向应用用户开放 `data/` 的读写权限。

应用进程不应拥有代码目录的写权限，数据库和对象目录不能通过静态文件服务直接暴露。若通过反向代理提供 HTTPS，应根据代理层级设置 `TRUST_PROXY` 和 `COOKIE_SECURE`。

### Docker 快速启动

在 `.env` 中设置：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请替换为至少12位的强密码
COOKIE_SECURE=false
MAX_UPLOAD_BYTES=1073741824
```

然后运行：

```bash
docker compose up --build -d
```

访问 `http://localhost:3000`。`docker-compose.yml` 将宿主机的 `./data` 挂载到容器的 `/data`，数据库和文件内容都保存在该目录。Compose 配置了 `/api/health` 健康检查，服务默认使用 Node.js 24 多阶段镜像构建。

### systemd 示例

```ini
[Unit]
Description=Local File Hub
After=network.target

[Service]
Type=simple
User=localfilehub
WorkingDirectory=/opt/local-file-hub
Environment=NODE_ENV=production
Environment=DATA_DIR=/srv/local-file-hub/data
ExecStart=/usr/bin/env npm run start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

请根据实际 Node.js/npm 安装路径调整 `ExecStart`。

## 备份与恢复

仓库提供内置备份脚本：

```bash
npm run backup
```

脚本默认读取 `DATA_DIR` / `DB_PATH` / `OBJECT_DIR`，在 `BACKUP_DIR` 下创建带时间戳的备份目录，并执行：

1. `PRAGMA integrity_check`，结果为 `ok` 才继续；
2. 调用 `better-sqlite3` 的在线 `backup()`，生成与 WAL 一致的 SQLite 快照；
3. 递归归档 `objects/` 中的文件内容，跳过符号链接；
4. 不包含 `uploads/` 临时目录；
5. 自动清理旧目录，默认只保留最近 7 份。

完整恢复必须同时使用备份目录中的 `local-file-hub.sqlite` 和 `objects/`。生产环境仍应定期执行恢复演练、把备份复制到独立磁盘，并确保备份目录和数据库目录的访问权限受到限制。

## 项目阶段

### v0.1.2 核心能力（纳入 v0.1.3 正式发布）

- 文件与文件夹条目级六维 ACL、继承、指定员工权限管理和管理员绕过。
- 匿名公开分享链接：限时、限次、访问密码、撤销和分享溯源水印。
- 动态身份水印、图像预览/下载水印和 Markdown 导出 PDF 水印。
- 登录/注册/改密/重置密码限流、安全响应头和注册保护。
- 上传扩展名白名单、只读不可下载 403、下载与分享访问审计。
- 管理员水印配置 API/界面、用户配额 API/界面和全局审计 CSV。
- `npm run backup` 内置在线备份脚本。
- Node.js 22 / Node.js 24 双环境 typecheck 与 11 个测试文件、61 个用例全绿。

### 下一步：稳定性和易用性

- 分片上传、断点续传和上传任务持久化。
- 缩略图生成、音视频转码和更完善的媒体工作流。
- 更完善的移动端、弱网和批量文件操作。
- 下载审批流、敏感目录标记、多因子认证和设备管理。

### 按需扩展

- 用户手动离线收藏小文件。
- 分布式对象存储和跨区域同步。
- 更细粒度的操作审计、保留策略和合规策略。

## 当前版本说明

当前项目版本为 `0.1.3`，已创建 GitHub Release 和标签；npm 包尚未发布。版本基线与发布说明见 [`VERSION.md`](VERSION.md) 和 [`docs/releases/v0.1.3.md`](docs/releases/v0.1.3.md)。

生产部署前必须修改管理员账号和密码，并在发布前完成人工测试。首次启动会创建管理员；后续修改环境变量不会覆盖数据库中已有账号的密码。
