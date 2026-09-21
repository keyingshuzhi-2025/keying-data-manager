# 当前版本基线

本文档记录本次文档同步所对应的代码版本。它是文档基线，不创建新的 Git 标签，也不改变业务代码。

## 版本标识

| 项目 | 值 |
|---|---|
| 包版本 | `0.1.0`（`package.json` / `package-lock.json`） |
| 分支 | `dev-0.1.1` |
| 基线提交 | `d981f0c62d24153d4523a7994d8b593e4f79bcaa` |
| 基线提交时间 | `2026-09-16T21:45:15+08:00` |
| 已有标签 | `v0.1.0` |
| 文档同步时间 | `2026-09-21` |

## 同步范围

- 文档以当前工作区的实际实现为准。
- 本次只更新仓库自有文档和配置示例，不修改业务代码。
- 本次没有创建新的 Git commit 或 Git tag。
- `node_modules/` 中依赖包的文档不属于本项目的维护范围。

## 当前工作区代码状态

基线提交之上已有以下未提交的后端/测试改动；README 已按这些实现同步：

- `apps/server/src/activity-log.ts`
- `apps/server/src/auth.ts`
- `apps/server/src/db/database.ts`
- `apps/server/src/db/schema.ts`
- `apps/server/src/file-service.ts`
- `apps/server/src/routes/admin.ts`
- `apps/server/src/routes/auth.ts`
- `apps/server/src/routes/files.ts`
- `apps/server/src/types.ts`
- `apps/server/test/app.integration.test.ts`
- `apps/server/test/database.test.ts`

这些改动主要涉及：

- SQLite schema 迁移到 `user_version = 5`；
- 用户存储配额字段；
- 文件 `uploaded_by` 元数据；
- 会话 IP / User-Agent 元数据；
- 活动日志查询；
- 非管理员上传配额校验；
- 相关单元和 API 集成测试。

## 版本使用方式

- `v0.1.0` 是仓库中已有的发布标签。
- 当前分支仍处于 `dev-0.1.1` 开发状态；在创建新的发布标签前，应以 `VERSION.md` 和 `README.md` 的“当前状态”章节核对实现范围。
- 如果后续提交代码或创建新标签，应同步更新本文档的基线提交、分支和工作区状态。
