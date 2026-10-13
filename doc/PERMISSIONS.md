# 权限体系文档（v0.1.2 · 条目级继承 ACL）

> 当前项目版本：`0.1.2`。本文档描述文件/文件夹条目 ACL、员工授权及其继承行为。

---

## 1. 概述

权限体系分为**两层**，按优先级叠加：

1. **员工条目 ACL**：`item_permissions` 表，按“员工 + 文件/文件夹”单独配置，并沿目录树继承；
2. **ROOT/兼容 ACL**：`folder_permissions` 保存 ROOT 默认策略与旧版目录规则；
3. **账号基线权限**：`users.can_read / can_upload / can_edit`，ROOT 默认策略生效时与账号基线取交集。

**管理员始终全权（admin bypass）**，不受任何 ACL 限制。

### 1.1 六维权限

| 权限 | 说明 |
|---|---|
| `read` | 浏览目录、查看元数据、在线预览（水印版） |
| `download` | 下载 / 流式播放；`false` 时"可看不可拷" |
| `upload` | 上传文件、新建子文件夹 |
| `edit` | 文件管理：重命名 / 移动 / 复制 / 删除 |
| `edit_md` | MD 内容编辑：仅对 `.md` 文件在线编辑与保存 |
| `share` | 创建/管理公开分享链接（第 4 章） |

---

## 2. 生效规则

- 员工在文件/文件夹上的单独 ACL 优先于共享目录策略；文件夹上的员工 ACL 会向子项继承，子项可再单独覆盖；
- 未命中员工条目 ACL 时沿目录链解析共享 ACL，ROOT 策略再与账号基线取交集；
- 文件操作会解析文件自身及其上级文件夹权限；上传/复制按目标文件夹判定；
- 根目录标识为虚拟值 `'ROOT'`，不指向 `files` 任何行，故 `folder_permissions` 无外键；
- ROOT 策略与账号基线取交集，避免迁移后静默扩大原有账号权限；显式子目录 ACL 按管理员配置生效。

### 2.1 权限解析优先级（authz.ts）

1. 管理员 → 全开（`source = 'admin'`）；
2. 目标员工最近的显式条目 ACL（`source = 'item'`）；
3. 最近共享目录 ACL（`source = 'folder'`）；
4. ROOT 默认策略（`source = 'root'`），与员工账号基线取交集；
5. 仅当 ACL 表缺失时 → 用户账号基线（`source = 'legacy'`，迁移过渡兜底）。

---

## 3. 数据结构

### 3.1 `folder_permissions`

```sql
CREATE TABLE folder_permissions (
  folder_id TEXT PRIMARY KEY,              -- files.id；'ROOT' 为根目录默认策略
  can_read INTEGER NOT NULL DEFAULT 0,
  can_download INTEGER NOT NULL DEFAULT 0,
  can_upload INTEGER NOT NULL DEFAULT 0,
  can_edit INTEGER NOT NULL DEFAULT 0,
  can_edit_md INTEGER NOT NULL DEFAULT 0,
  can_share INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
```

### 3.2 `app_config`（站点配置）

| key | 值 | 说明 |
|---|---|---|
| `folder_permissions_default_mode` | `'open'` / `'tighten'` | ROOT 默认策略模式，迁移默认写入 `'open'` |

- `open`：ROOT 策略为全开（1,1,1,1,1,1），实际权限仍与用户账号基线取交集；
- `tighten`：仅读 + 下载（1,1,0,0,0,0）——"默认收紧"配置开关（计划 §5.2）。

### 3.3 `users.can_*`（退役保留）

`can_read` / `can_upload` / `can_edit` 仍在 schema 中保留，映射为账号基线：`read` 与 `download` 跟随 `can_read`，`upload` 跟随 `can_upload`，`edit` 跟随 `can_edit`；新增的 `editMd` 和 `share` 默认关闭。`can_manage_permissions` 表示管理员是否授权该员工管理条目 ACL。ROOT 策略会与账号基线取交集；员工条目 ACL 可按具体文件或文件夹覆盖它。

---

### 3.2 `item_permissions`

```sql
CREATE TABLE item_permissions (
  item_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  can_read INTEGER NOT NULL DEFAULT 0,
  can_download INTEGER NOT NULL DEFAULT 0,
  can_upload INTEGER NOT NULL DEFAULT 0,
  can_edit INTEGER NOT NULL DEFAULT 0,
  can_edit_md INTEGER NOT NULL DEFAULT 0,
  can_share INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_id, user_id)
);
```

管理员可在用户管理中授予员工“管理文件和文件夹权限”能力。获授权员工可从条目卡片选择目标员工并设置六项权限。

## 4. 迁移（schema v8，db/database.ts）

项目版本 `0.1.2` 当前使用 SQLite schema `user_version = 8`。v7 迁移创建 `folder_permissions` 并种子 ROOT；v8 增加 `item_permissions` 和 `users.can_manage_permissions`：

1. 每次启动幂等确保 `folder_permissions` 与 ROOT 默认策略存在；
2. 写入 `app_config.folder_permissions_default_mode = 'open'`（不覆盖已有值）；
3. schema 创建 `item_permissions`，用户表迁移增加 `can_manage_permissions`；
4. 构造函数完成全部迁移后设置 `PRAGMA user_version = 8`。

`user_version` 是 SQLite schema 版本，不等同于应用包版本 `0.1.2`。

---

## 5. 管理端接口（admin.ts）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/api/admin/permissions` | 读取或更新指定员工在单个文件/文件夹上的 ACL |
| GET | `/api/permissions/acl-users` | 已授权的权限管理员可获取员工选择列表 |
| GET | `/api/admin/permissions/all` | 管理员只读：ROOT、目录规则及员工条目 ACL |
| GET | `/api/admin/permissions-health` | 管理员只读：健康检查（表存在性 / ROOT / 模式 / 计数 / 告警） |
| GET | `/api/admin/permissions-chain?userId=&itemId=` | 管理员只读：指定用户-目标的完整权限链（逐跳显式 ACL + 命中点 + 继承语义） |

员工条目 ACL 接口需要管理员或被指定的权限管理员身份；健康检查与全局 ACL 总览仅管理员可访问。

### 5.1 健康检查字段（/permissions-health）

```json
{
  "ok": true,
  "tableExists": true,
  "tableVersion": 8,
  "rootMode": "open",
  "rootAclPresent": true,
  "aclRowCount": 1,
  "findings": [
    { "code": "ONLY_ROOT_ACL", "severity": "info", "message": "当前仅配置了 ROOT 默认策略，未设置任何子目录 ACL。" }
  ]
}
```

告警编码：`ACL_TABLE_MISSING`（critical）/ `ROOT_ACL_MISSING`（critical）/ `ROOT_ACL_TOO_RESTRICTIVE`（warning）/ `ONLY_ROOT_ACL`（info）/ `TIGHTEN_INCONSISTENT`（warning）。

### 5.2 权限链字段（/permissions-chain）

```json
{
  "target": { "kind": "folder", "id": "f123" },
  "hops": [
    {
      "folderId": "f123",
      "name": "研发资料",
      "configured": { "read": true, "download": false, "upload": false, ... },
      "configuredSource": "item",
      "isEffective": true,
      "parentId": "parent-id",
      "inheritedFromNearby": false,
      "inheritedFromRoot": false
    },
    ...
  ],
  "effective": { ... },
  "source": "folder",
  "folderId": "f123",
  "userBaseline": { ... }
}
```

---

## 6. 前端入口

- 管理员在用户管理（`UserManagementDialog`）中可授予指定员工“管理文件和文件夹权限”能力；
- 文件库页的文件/文件夹卡片 → **权限设置**：选择员工并单独设置当前条目的六项权限；
- 管理员从文件库顶部打开 **权限链**（PermissionChainViewer）：查看用户、条目链路、健康检查和已配置 ACL；
- 用户与权限中的账号权限是默认基线，员工条目 ACL 可按具体文件或文件夹覆盖；
- 权限编辑弹窗（`PermissionEditorModal`）→ 描述同上。

---

## 7. 决策与影响（重要）

- ROOT 默认 = **open** 表示站点策略矩阵全开，实际每个账号仍受自身基线约束；管理员可切换 `tighten` 或为子目录设置显式 ACL。
- 原有受限账号在 ROOT 下不会因迁移而增加权限；管理员对具体子目录配置的 ACL 仍可明确授权例外。
- `users.can_*` 保留为账号基线，ACL 表缺失时也继续提供兼容授权。

---

## 8. 测试

- `apps/server/test/authz.test.ts`：ACL 继承矩阵、防锁死、管理员绕过、权限链跳、ROOT 兜底、tighten 模式、健康检查告警、legacy 退役；
- `apps/server/test/migration-v7.test.ts`：ROOT 种子、模式配置、二次构造幂等、旧库兼容（表存在无 ROOT / 表完全缺失 / 保留既有配置）、遗留列保留。
