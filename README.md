# 局域网文件共享站（Local File Hub）

一个面向局域网的轻量文件共享平台。用户可以通过浏览器上传、浏览、预览、下载和管理文档、图片、音频、视频等文件，并可将 Web 应用安装为 PWA。

项目只解决**文件在本地网络中的集中存储与共享**：文件内容保存在服务器本地目录，SQLite 只保存文件元数据，不依赖云服务或公网服务。

> 当前仓库已实现本文中所列的 MVP 能力。

## 核心目标

- 在局域网内集中保存和共享文件。
- 支持文档、图片、音频、视频及其他普通文件。
- 提供可安装、响应式的 PWA Web 界面。
- 支持文件上传、下载、预览、搜索、分类、移动、重命名和删除。
- 使用 SQLite 管理文件元数据，使用服务器本地目录保存二进制内容。
- 保持部署简单，可在普通 Linux 服务器、NAS 或高性能工作站上运行。
- 默认同站同源部署，不依赖对象存储、消息队列或外部 API。

## 明确不在当前范围内

以下能力不属于第一阶段目标：

- AI 知识库、向量检索和自动内容总结。
- 公有云同步和跨地域分发。
- 多人实时协同编辑。
- 在线音视频转码、复杂媒体工作流。
- 分布式文件系统、文件夹/文件级的细粒度权限体系。
- 将大体积媒体文件默认缓存到浏览器离线使用。

## 技术架构

项目采用前后端分离的单仓库架构。开发环境分别运行 Vite 与 Fastify，生产环境由同一个 Node.js 服务提供 API 和前端静态资源，避免额外的 CORS 配置和部署端口。

```text
Browser / PWA
      |
      | HTTP + JSON / multipart / Range
      v
+-----------------------+
| Node.js + Fastify     |
| API / Auth / Stream   |
+-----------+-----------+
            |
            +--------------> SQLite（元数据）
            |
            +--------------> 本地对象存储目录（文件内容）
            |
            +--------------> dist/（生产环境前端静态资源）
```

### 前端

- **React**：组件化构建文件列表、上传界面和媒体预览界面。
- **Vite**：开发服务器和生产构建。
- **TypeScript**：约束 API 数据类型和前端业务模型。
- **TanStack Query**：处理文件列表、上传状态、缓存和请求重试。
- **原生 CSS + CSS Variables**：实现响应式布局和主题，不引入大型 UI 框架。
- **Vite PWA Plugin**：生成 Manifest、图标和 Service Worker。

前端不直接访问 SQLite 或本地文件系统，所有数据操作都通过后端 API 完成。

### 后端

- **Node.js 22.12+ LTS**：统一前后端 JavaScript/TypeScript 运行环境。
- **Fastify**：提供轻量、高性能的 REST API 和文件流处理。
- **TypeScript**：统一服务端类型定义和接口校验。
- **better-sqlite3**：访问 SQLite，适合本地单节点、读多写少的工作负载。
- **Zod**：校验请求参数、上传元数据和配置文件。
- **Node.js 内置 `crypto`**：生成文件标识、计算哈希并安全存储密码，减少不必要的原生依赖。
- **pino**：结构化运行日志。

### 为什么不选择其他方案

- 不使用 MongoDB/PostgreSQL：当前是单节点局域网应用，SQLite 更易于备份和迁移。
- 不使用 MinIO：文件已经存放在服务器本地目录，引入对象存储服务会增加运维复杂度。
- 不使用 Next.js：本项目不需要服务端渲染；Vite SPA 更简单，PWA 行为也更容易控制。
- 不引入 Electron/Tauri：用户通过浏览器访问即可，不需要为每台设备安装桌面客户端。

## 目录设计

```text
.
├── package.json                 # 依赖与统一脚本
├── apps
│   ├── web                      # React/Vite/PWA 前端
│   │   ├── public
│   │   │   ├── icon.svg
│   │   │   └── pwa-*.png        # PWA 图标
│   │   └── src
│   │       ├── api              # API 客户端
│   │       ├── components       # 通用组件
│   │       ├── features
│   │       │   ├── auth         # 登录
│   │       │   └── files        # 文件列表、上传、预览和管理
│   │       ├── hooks
│   │       ├── styles
│   │       └── utils
│   └── server                   # Fastify 后端
│       ├── src
│       │   ├── db
│       │   ├── routes           # 认证和文件路由
│       │   ├── auth.ts
│       │   ├── file-service.ts
│       │   └── storage.ts
│       └── test                 # 单元与集成测试
├── data                         # 本地运行数据（不提交到 Git）
│   ├── db
│   │   └── local-file-hub.sqlite
│   ├── objects                  # 实际文件二进制内容
│   └── uploads                  # 未完成上传的临时文件
├── docker-compose.yml           # 可选：应用容器
├── Dockerfile
└── README.md
```

`data/` 仅用于本地开发。生产环境应通过环境变量将数据库和对象存储指向独立磁盘，例如 `/srv/local-file-hub/data`，不要与代码目录混用。

## 数据模型

SQLite 只保存文件元数据，不保存 BLOB 文件内容。

### `users`

| 字段 | 说明 |
|---|---|
| `username` / `password_hash` | 登录账号和加盐 scrypt 密码哈希 |
| `role` | `admin` 或 `user` |
| `is_enabled` | 停用后不能登录，已有会话会立即失效 |
| `can_read` | 浏览、预览、流式播放和下载到本地 |
| `can_upload` | 上传文件和新建文件夹 |
| `can_edit` | 重命名、移动、复制和删除 |

首次启动时会根据 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 创建管理员。管理员始终拥有全部权限，可以在界面中启用/停用普通用户并分别授予上述三类权限。读取是上传和编辑的前提，而新注册账号默认不拥有任何文件权限。

### `files`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT | UUID，文件唯一标识 |
| `parent_id` | TEXT | 父目录 ID；根目录为空 |
| `name` | TEXT | 用户看到的文件名 |
| `object_id` | TEXT | 本地存储对象标识 |
| `mime_type` | TEXT | MIME 类型 |
| `extension` | TEXT | 小写扩展名 |
| `size_bytes` | INTEGER | 文件字节数 |
| `sha256` | TEXT | 完整文件 SHA-256，可用于校验 |
| `created_at` | TEXT | ISO-8601 时间 |
| `updated_at` | TEXT | ISO-8601 时间 |
| `deleted_at` | TEXT | 软删除时间；为空表示有效 |

主要索引：

- `files(parent_id, deleted_at, created_at)`
- `files(name COLLATE NOCASE, deleted_at)`
- `files(mime_type, deleted_at)`
- `files(size_bytes, deleted_at)`

目录使用 `files` 表自关联表示，根目录是虚拟节点，不需要单独写入文件内容。删除目录时，应先检查子项并返回明确错误，避免误删深层文件。

## 文件存储设计

实际内容存放在：

```text
data/objects/<id 前两位>/<完整 id>.blob
```

示例：

```text
data/objects/ab/abcd1234....blob
```

存储规则：

1. 上传内容先进入 `data/uploads/` 下的临时文件。
2. 完成后计算大小和 SHA-256。
3. 通过原子重命名写入 `data/objects/`。
4. 文件落盘成功后，再在 SQLite 中写入元数据。
5. 删除文件时先软删除，再由后台任务清理不再引用的对象。
6. API 只返回文件 ID，不暴露服务器绝对路径。

这种设计避免文件名、路径字符集和目录层级影响底层存储，也能防止路径穿越。

## API 设计

API 前缀为 `/api`，请求和响应默认使用 JSON。大文件上传使用 `multipart/form-data`，下载和媒体播放使用 HTTP Range 流式响应。

### 健康检查

```text
GET /api/health
```

### 认证

```text
POST   /api/auth/login
POST   /api/auth/register
POST   /api/auth/logout
GET    /api/auth/session
```

密码使用加盐的 `scrypt` 哈希存储；会话令牌只保存哈希值，通过 `HttpOnly`、`SameSite=Strict` Cookie 发送。注册成功会自动登录，但文件功能需等待管理员授权。

### 管理员用户接口

```text
GET    /api/admin/users
PATCH  /api/admin/users/:id
```

管理员可更新 `isEnabled` 和 `permissions` （`read`、`upload`、`edit`）。所有文件 API 在服务端强制校验对应权限，前端隐藏按钮不是唯一防线。

### 文件和目录

```text
GET    /api/files
POST   /api/files
GET    /api/files/:id
GET    /api/files/:id/path
PATCH  /api/files/:id
POST   /api/files/:id/move
POST   /api/files/:id/copy
DELETE /api/files/:id
```

`GET /api/files` 支持：

- `parentId`：目录浏览
- `q`：按文件名搜索
- `type`：文档、图片、音频、视频或其他
- `sort`：名称、大小、创建时间
- `page` / `limit`：分页

### 上传

```text
POST /api/uploads
```

上传请求包含文件、目标目录和可选的期望文件名。后端限制文件大小、校验内容类型，并在临时目录中完成写入。

大文件可以后续扩展为分片上传：

```text
POST   /api/uploads/init
PUT    /api/uploads/:uploadId/chunks/:chunkIndex
POST   /api/uploads/:uploadId/complete
DELETE /api/uploads/:uploadId
```

MVP 阶段先实现单请求上传；分片上传不作为第一版交付条件。

### 下载和媒体流

```text
GET /api/files/:id/download
GET /api/files/:id/stream
```

下载接口支持 `Range` 请求，返回 `206 Partial Content`、`Accept-Ranges` 和正确的 `Content-Type`。图片、音频和视频可直接通过浏览器原生元素预览：

- 图片：`<img>`
- 音频：`<audio controls>`
- 视频：`<video controls playsinline>`

第一阶段不要求服务器生成缩略图或转码；浏览器不支持的媒体格式提供下载。

## PWA 设计

PWA 是 Web 应用的安装和离线能力，不意味着默认离线保存所有媒体文件。

### 可安装

- `manifest.webmanifest` 包含名称、短名称、启动地址、显示模式和主题色。
- 提供适合不同设备尺寸的图标。
- 支持从 Chrome、Edge、Safari 等浏览器安装到桌面或主屏幕。

### Service Worker 缓存

默认缓存：

- 应用 HTML、JavaScript、CSS 和图标等应用壳资源。

默认不缓存：

- 大体积图片、音频和视频。
- 上传和下载响应。
- 登录信息、用户权限和所有 API 响应。

用户以后可以手动选择“离线可用”的单个小文件，但媒体离线缓存需要单独设计容量上限和清理策略。

### 离线体验

- 已安装的应用壳可以在网络断开后启动。
- 文件目录和内容不缓存，以避免在共享设备上泄漏受保护的数据。
- 上传任务在网络中断时失败后允许重新选择或重试，不把临时文件标记为已完成。

## 安全与可靠性

即使只在局域网运行，也不应把服务视为完全可信环境。

- 默认启用登录，不直接暴露无认证的文件接口。
- 所有上传文件名经过规范化，禁止路径分隔符和隐藏的系统路径。
- 后端自行拼接存储路径，不接受客户端提供的绝对路径。
- 校验文件大小、MIME 类型和扩展名，防止伪装上传。
- 对 API 输入使用 Zod 校验，统一错误响应。
- 下载接口只接受数据库中的文件 ID。
- 会话 Cookie 使用 `HttpOnly`、`SameSite=Strict`，生产环境启用 `Secure`。
- 限制单文件大小、并发上传数和请求体大小。
- SQLite 启用外键、WAL 模式、`busy_timeout` 和事务。
- 文件写入和元数据写入采用“先落盘、后提交”的恢复策略；进程异常时通过启动扫描清理孤立临时文件。
- 日志不记录完整 Cookie、会话令牌或文件内容。
- 服务默认只监听局域网地址，不应直接暴露到公网。

## 备份与恢复

SQLite 数据库和本地对象目录必须同时备份，只备份其中一个无法完整恢复文件。

建议备份：

```text
data/db/local-file-hub.sqlite
data/objects/
```

生产环境应：

1. 定期执行 SQLite 一致性检查。
2. 使用 `sqlite3 .backup` 或等价方式创建一致性快照。
3. 将数据库快照和 `objects/` 目录归档到独立磁盘。
4. 定期执行恢复演练，而不只是检查备份文件是否存在。
5. 在备份期间避免直接复制处于写入状态的数据库文件。

## 本地开发

### 环境要求

- Node.js 22.12 或更高版本（推荐 Node.js 24 LTS）
- npm 9 或更高版本
- 支持 SQLite 的 Linux、macOS 或 Windows 开发环境

### 安装

```bash
npm install
```

### 启动开发环境

```bash
npm run dev
```

该命令同时启动：

- Vite 前端开发服务器
- Fastify API 服务

开发环境下，Vite 通过代理将 `/api` 请求转发到后端。

也可以分别启动：

```bash
npm run dev:web
npm run dev:server
```

### 类型检查和测试

```bash
npm run typecheck
npm test
```

### 构建和运行生产版本

```bash
npm run build
NODE_ENV=production \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD='请替换为至少12位的强密码' \
npm run start
```

生产环境访问：

```text
http://localhost:3000
```

默认端口和运行目录可以通过环境变量修改。

## 生产部署

### 推荐环境

- Ubuntu Server 22.04/24.04 LTS
- Node.js 22.12+ LTS
- 独立数据盘或 RAID 卷
- Nginx/Caddy 反向代理（可选）
- systemd 进程守护

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `NODE_ENV` | `production` | 运行环境 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `3000` | HTTP 端口 |
| `DATA_DIR` | `./data` | 数据库和对象存储根目录 |
| `DB_PATH` | `${DATA_DIR}/db/local-file-hub.sqlite` | SQLite 文件 |
| `OBJECT_DIR` | `${DATA_DIR}/objects` | 文件内容目录 |
| `UPLOAD_DIR` | `${DATA_DIR}/uploads` | 临时上传目录 |
| `WEB_DIST_DIR` | `./dist/web` | 生产前端构建目录 |
| `PUBLIC_URL` | 根据部署配置 | PWA 和回调使用的公网/局域网地址 |
| `MAX_UPLOAD_BYTES` | 根据磁盘配置 | 单文件上传上限 |
| `ADMIN_USERNAME` | 仅开发默认 `admin` | 管理员账号；生产环境必须显式设置 |
| `ADMIN_PASSWORD` | 仅开发默认 `admin123` | 管理员密码；生产环境至少 12 字节 |

### 运行权限

- 应用进程只应拥有 `data/` 的读写权限。
- 代码目录应保持只读。
- 数据库和对象目录不能通过静态文件服务直接暴露。
- 如果通过反向代理提供 HTTPS，应同步设置可信代理和安全 Cookie 参数。

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
ExecStart=/usr/bin/npm run start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## 项目阶段

### 第一阶段：可用文件共享

- 注册、登录、会话管理与管理员权限分配。
- 文件上传、列表、下载、删除、重命名和移动。
- 图片、音频、视频在线预览。
- 文件名搜索和类型筛选。
- SQLite 元数据管理。
- 基础 PWA Manifest 和 Service Worker。

### 第二阶段：稳定性和易用性

- 大文件分片上传和断点续传。
- 上传进度、失败重试和临时文件清理。
- 更完整的目录操作和批量操作。
- 数据库及对象存储备份脚本。
- 更完善的移动端和弱网体验。

### 第三阶段：按需扩展

- 用户手动离线收藏小文件。
- 可选缩略图生成。
- 文件夹级权限、操作审计日志。
- 操作审计日志。
- Docker 镜像和一键部署脚本。

## 当前状态

第一阶段 MVP 已实现：后端 API、注册登录、管理员授权、本地对象存储、SQLite 元数据、文件管理、Range 流式传输，以及响应式 React/PWA 前端均可运行。仓库包含后端单元和 API 集成测试。

生产部署前必须修改管理员账号和密码。首次启动会创建管理员；后续修改环境变量不会覆盖数据库中已有账号。

### Docker 快速启动

在 `.env` 中设置：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请替换为至少12位的强密码
```

然后运行：

```bash
docker compose up --build -d
```

访问 `http://localhost:3000`。数据库和文件内容保存在宿主机的 `data/` 目录。
