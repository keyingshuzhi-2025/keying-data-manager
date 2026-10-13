import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { HubDatabase } from '../src/db/database.js';
import {
  allPermissions,
  getFolderAcls,
  getPermissionChain,
  getPermissionsHealth,
  legacyPermissionsForUser,
  noPermissions,
  resolveConfiguredPermissionSource,
  resolveEffectivePermissions,
  resolveEffectivePermissionChain,
  resolvePermissionSource,
  ROOT_FOLDER_ID,
  FOLDER_PERMISSIONS_DEFAULT_MODE_KEY,
  type AuthzPermission,
  type PermissionSet,
} from '../src/authz.js';
import type { AuthUser } from '../src/types.js';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'u-user',
    username: 'user',
    role: 'user',
    isEnabled: true,
    permissions: {
      read: false,
      download: false,
      upload: false,
      edit: false,
      editMd: false,
      share: false,
    },
    storageQuotaBytes: 0,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
    ...overrides,
  };
}

function perms(partial: Partial<Record<AuthzPermission, boolean>> = {}): PermissionSet {
  return { ...noPermissions(), ...partial };
}

describe('authz 文件夹级权限解析', () => {
  let directory: string;
  let db: HubDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'local-file-hub-authz-'));
    db = new HubDatabase(join(directory, 'hub.sqlite'));
  });

  afterEach(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  function insertFolder(id: string, parentId: string | null): void {
    db.sqlite.prepare(
      `INSERT INTO files (id, parent_id, name, kind, created_at, updated_at)
       VALUES (?, ?, ?, 'folder', ?, ?)`,
    ).run(id, parentId, id, new Date().toISOString(), new Date().toISOString());
  }

  function insertFile(id: string, parentId: string | null): void {
    db.sqlite.prepare(
      `INSERT INTO files (id, parent_id, name, kind, object_id, created_at, updated_at)
       VALUES (?, ?, ?, 'file', 'obj', ?, ?)`,
    ).run(id, parentId, id, new Date().toISOString(), new Date().toISOString());
  }

  function setAcl(folderId: string, p: PermissionSet): void {
    db.sqlite.prepare(
      `INSERT INTO folder_permissions
         (folder_id, can_read, can_download, can_upload, can_edit, can_edit_md, can_share, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(folder_id) DO UPDATE SET
        can_read = excluded.can_read, can_download = excluded.can_download,
        can_upload = excluded.can_upload, can_edit = excluded.can_edit,
        can_edit_md = excluded.can_edit_md, can_share = excluded.can_share,
        updated_at = excluded.updated_at`,
    ).run(
      folderId,
      Number(p.read), Number(p.download), Number(p.upload),
      Number(p.edit), Number(p.editMd), Number(p.share),
      'u-admin', new Date().toISOString(),
    );
  }

  it('管理员始终全权绕过（source=admin）', () => {
    const admin = makeUser({ role: 'admin' });
    const resolution = resolvePermissionSource(db.sqlite, admin, { kind: 'root' });
    expect(resolution.source).toBe('admin');
    expect(resolution.permissions).toEqual(allPermissions());
    expect(resolution.folderId).toBeNull();
  });

  it('未配置任何 ACL 时回退到用户遗留权限（source=legacy）', () => {
    // 模拟迁移未落地：ACL 表不存在，authz 才走 legacy 回退。
    db.sqlite.exec('DROP TABLE IF EXISTS folder_permissions');
    const legacyUser = makeUser({ permissions: perms({ read: true }) });
    insertFolder('f1', null);
    const resolution = resolvePermissionSource(db.sqlite, legacyUser, { kind: 'folder', id: 'f1' });
    expect(resolution.source).toBe('legacy');
    // download 跟随 read（历史行为）；editMd/share 默认关闭
    expect(resolution.permissions).toEqual(perms({ read: true, download: true }));
  });

  it('根目录默认策略（ROOT）对根目录目标生效（source=root）', () => {
    const user = makeUser({ permissions: perms({ read: true, upload: true }) });
    setAcl(ROOT_FOLDER_ID, perms({ read: true, upload: true }));
    const resolution = resolvePermissionSource(db.sqlite, user, { kind: 'root' });
    expect(resolution.source).toBe('root');
    expect(resolution.folderId).toBe(ROOT_FOLDER_ID);
    expect(resolution.permissions).toEqual(perms({ read: true, upload: true }));
  });

  it('目录链自近向远取最近 ACL：子目录覆盖父目录与 ROOT', () => {
    const user = makeUser();
    insertFolder('parent', null);
    insertFolder('child', 'parent');
    setAcl(ROOT_FOLDER_ID, perms({ read: true }));
    setAcl('parent', perms({ read: true, upload: true }));

    const childResolution = resolvePermissionSource(db.sqlite, user, { kind: 'folder', id: 'child' });
    expect(childResolution.source).toBe('folder');
    expect(childResolution.folderId).toBe('parent'); // 最近命中父目录
    expect(childResolution.permissions).toEqual(perms({ read: true, upload: true }));

    const parentResolution = resolvePermissionSource(db.sqlite, user, { kind: 'folder', id: 'parent' });
    expect(parentResolution.permissions).toEqual(perms({ read: true, upload: true }));
  });

  it('文件按其所在目录判定权限；根目录文件用 ROOT 策略', () => {
    const user = makeUser({ permissions: perms({ read: true }) });
    insertFolder('parent', null);
    insertFile('root-file', null);
    insertFile('child-file', 'parent');
    setAcl(ROOT_FOLDER_ID, perms({ read: true }));
    setAcl('parent', perms({ read: true, download: true, share: true }));

    expect(resolveEffectivePermissions(db.sqlite, user, { kind: 'file', id: 'root-file' }))
      .toEqual(perms({ read: true }));
    expect(resolveEffectivePermissions(db.sqlite, user, { kind: 'file', id: 'child-file' }))
      .toEqual(perms({ read: true, download: true, share: true }));
  });

  it('ACL 命中时完全接管：未授予的维度即使遗留开启也关闭', () => {
    const legacyReadUser = makeUser({ permissions: perms({ read: true, upload: true }) });
    insertFolder('f1', null);
    // 仅授予 download（无 read），ACL 命中后 upload 应被关掉
    setAcl('f1', perms({ download: true }));
    const resolution = resolvePermissionSource(db.sqlite, legacyReadUser, { kind: 'folder', id: 'f1' });
    expect(resolution.source).toBe('folder');
    expect(resolution.permissions).toEqual(perms({ download: true }));
  });

  it('不存在的目录抛 404（AppError.statusCode=404）', () => {
    const user = makeUser();
    expect(() => resolvePermissionSource(db.sqlite, user, { kind: 'folder', id: 'missing' }))
      .toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(() => resolveEffectivePermissions(db.sqlite, user, { kind: 'file', id: 'missing' }))
      .toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it('resolveConfiguredPermissionSource 在无 ACL 时返回全关 + legacy 占位', () => {
    // 模拟迁移未落地：ACL 表不存在，authz 才走 legacy 回退。
    db.sqlite.exec('DROP TABLE IF EXISTS folder_permissions');
    insertFolder('f1', null);
    const source = resolveConfiguredPermissionSource(db.sqlite, { kind: 'folder', id: 'f1' });
    expect(source).toEqual({
      permissions: noPermissions(),
      source: 'legacy',
      folderId: null,
    });
  });

  it('legacyPermissionsForUser 映射与最小权限默认一致', () => {
    const user = makeUser({ permissions: perms({ read: true, edit: true }) });
    expect(legacyPermissionsForUser(user)).toEqual(perms({ read: true, download: true, edit: true }));
  });

  // ---------- v0.1.2：权限链（管理员查看器） ----------

  it('getPermissionChain 返回完整的目录链跳数（目标目录、父目录、ROOT）', () => {
    const user = makeUser();
    insertFolder('parent', null);
    insertFolder('child', 'parent');
    insertFile('f', 'child');

    const childChain = getPermissionChain(db.sqlite, user, { kind: 'folder', id: 'child' });
    expect(childChain.hops).toHaveLength(3);
    expect(childChain.hops.map((h) => h.folderId)).toEqual(['child', 'parent', 'ROOT']);
    expect(childChain.hops[0]?.name).toBe('child');
    expect(childChain.hops[2]?.name).toBe('根目录（默认策略）');

    const fileChain = getPermissionChain(db.sqlite, user, { kind: 'file', id: 'f' });
    expect(fileChain.hops.map((h) => h.folderId)).toEqual(['child', 'parent', 'ROOT']);
  });

  it('getPermissionChain 标注命中点：最近显式 ACL 所在跳 isEffective=true', () => {
    const user = makeUser();
    insertFolder('parent', null);
    insertFolder('child', 'parent');
    setAcl('parent', perms({ read: true, upload: true }));

    const chain = getPermissionChain(db.sqlite, user, { kind: 'folder', id: 'child' });
    const parentHop = chain.hops.find((h) => h.folderId === 'parent');
    expect(parentHop?.isEffective).toBe(true);
    expect(parentHop?.configured).toEqual(perms({ read: true, upload: true }));
    const childHop = chain.hops.find((h) => h.folderId === 'child');
    expect(childHop?.isEffective).toBe(false);
    expect(childHop?.configured).toBeNull();
    expect(childHop?.inheritedFromNearby).toBe(true);
  });

  it('getPermissionChain ROOT 兜底：链上无 ACL 时沿用到 ROOT', () => {
    const user = makeUser();
    insertFolder('parent', null);
    setAcl(ROOT_FOLDER_ID, perms({ read: true, download: true }));

    const chain = getPermissionChain(db.sqlite, user, { kind: 'folder', id: 'parent' });
    const rootHop = chain.hops.find((h) => h.folderId === ROOT_FOLDER_ID);
    expect(rootHop?.isEffective).toBe(true);
    expect(rootHop?.configured).toEqual(perms({ read: true, download: true }));
    const parentHop = chain.hops.find((h) => h.folderId === 'parent');
    expect(parentHop?.inheritedFromRoot).toBe(true);
  });

  it('getPermissionChain 管理员命中标记在 ROOT，生效权限为全开', () => {
    const admin = makeUser({ role: 'admin' });
    insertFolder('parent', null);
    setAcl('parent', perms({ read: true }));

    const chain = getPermissionChain(db.sqlite, admin, { kind: 'folder', id: 'parent' });
    expect(chain.source).toBe('admin');
    expect(chain.effective).toEqual(allPermissions());
    const rootHop = chain.hops.find((h) => h.folderId === ROOT_FOLDER_ID);
    expect(rootHop?.isEffective).toBe(true);
  });

  it('getPermissionChain 无 ACL 命中时回退用户基线并标记在 ROOT', () => {
    // 模拟迁移未落地：ACL 表不存在，authz 才走 legacy 回退。
    db.sqlite.exec('DROP TABLE IF EXISTS folder_permissions');
    const user = makeUser({ permissions: perms({ read: true }) });
    insertFolder('parent', null);

    const chain = getPermissionChain(db.sqlite, user, { kind: 'folder', id: 'parent' });
    expect(chain.source).toBe('legacy');
    expect(chain.folderId).toBeNull();
    const rootHop = chain.hops.find((h) => h.folderId === ROOT_FOLDER_ID);
    expect(rootHop?.isEffective).toBe(true);
  });

  it('getPermissionChain 的根兜底跳继承语义：无显式 ACL 时未配置跳 inheritedFromRoot=true', () => {
    const user = makeUser({ permissions: perms({ read: true }) });
    insertFolder('a', null);
    insertFolder('b', 'a');
    // ROOT 为默认策略，链上无其他显式 ACL：b 与 a 均继承自 ROOT。
    const chain = getPermissionChain(db.sqlite, user, { kind: 'folder', id: 'b' });
    const aHop = chain.hops.find((h) => h.folderId === 'a');
    const bHop = chain.hops.find((h) => h.folderId === 'b');
    expect(aHop?.inheritedFromRoot).toBe(true);
    expect(bHop?.inheritedFromRoot).toBe(true);
    expect(bHop?.inheritedFromNearby).toBe(false);
    expect(bHop?.parentId).toBe('a');
  });

  // ---------- v0.1.2：tighten 模式与健康检查 ----------

  it('tighten 模式下 ROOT 默认策略仅开启 read+download', () => {
    insertFolder('f1', null);
    // 通过 app_config 将模式切换为 tighten（迁移补全测试见 migration-v7.test.ts）
    db.sqlite.exec(`UPDATE app_config SET value = 'tighten' WHERE key = '${FOLDER_PERMISSIONS_DEFAULT_MODE_KEY}'`);
    const health = getPermissionsHealth(db.sqlite);
    expect(health.ok).toBe(true);
    expect(health.rootMode).toBe('tighten');
    expect(health.aclRowCount).toBe(1);
  });

  it('getPermissionsHealth 报告 ROOT_ACL_MISSING 当 ROOT 行缺失', () => {
    insertFolder('f1', null);
    db.sqlite.exec(`DELETE FROM folder_permissions WHERE folder_id = 'ROOT'`);
    const health = getPermissionsHealth(db.sqlite);
    expect(health.ok).toBe(false);
    expect(health.findings.some((f) => f.code === 'ROOT_ACL_MISSING')).toBe(true);
    expect(health.findings.find((f) => f.code === 'ROOT_ACL_MISSING')?.severity).toBe('critical');
  });

  it('getPermissionsHealth 报告 ONLY_ROOT_ACL 仅配置 ROOT 时', () => {
    const health = getPermissionsHealth(db.sqlite);
    expect(health.findings.some((f) => f.code === 'ONLY_ROOT_ACL')).toBe(true);
  });

  it('getFolderAcls 返回含目录名的清单', () => {
    insertFolder('p1', null);
    insertFolder('sub1', 'p1');
    setAcl('p1', perms({ read: true }));
    setAcl('sub1', perms({ download: true }));
    const entries = getFolderAcls(db.sqlite);
    const p1Entry = entries.find((e) => e.folderId === 'p1');
    const rootEntry = entries.find((e) => e.folderId === ROOT_FOLDER_ID);
    expect(rootEntry?.name).toBe('根目录（默认策略）');
    expect(p1Entry?.name).toBe('p1');
    expect(entries.length).toBe(3); // ROOT + p1 + sub1
  });

  it('ROOT 策略受账号基线约束，显式目录 ACL 可覆盖账号基线', () => {
    const legacyUser = makeUser({ permissions: perms({ read: true, upload: true }) });
    insertFolder('f1', null);
    setAcl(ROOT_FOLDER_ID, perms({ read: true })); // 仅 ROOT 有配置

    const resolution = resolvePermissionSource(db.sqlite, legacyUser, { kind: 'folder', id: 'f1' });
    expect(resolution.source).toBe('root'); // 命中 ROOT，不再走 legacy
    expect(resolution.permissions).toEqual(perms({ read: true, download: true }));
    expect(resolveEffectivePermissions(db.sqlite, legacyUser, { kind: 'folder', id: 'f1' })).toEqual(perms({ read: true, download: true }));

    setAcl('f1', perms({ read: true, upload: true }));
    expect(resolveEffectivePermissions(db.sqlite, makeUser(), { kind: 'folder', id: 'f1' }))
      .toEqual(perms({ read: true, upload: true }));
  });

  it('getPermissionChain 使用 resolveEffectivePermissionChain 返回相同 shape', () => {
    insertFolder('parent', null);
    setAcl('parent', perms({ read: true, upload: true }));
    const user = makeUser();

    const chain1 = getPermissionChain(db.sqlite, user, { kind: 'folder', id: 'parent' });
    const chain2 = resolveEffectivePermissionChain(db.sqlite, user, { kind: 'folder', id: 'parent' });
    expect(chain1).toMatchObject({
      target: { kind: 'folder', id: 'parent' },
      effective: chain2.effective,
      source: chain2.source,
      folderId: chain2.folderId,
    });
    expect(chain1.hops).toHaveLength(2);
    expect(chain2.hops[0]?.name).toBeDefined();
    expect(chain2.hops[0]?.parentId).toBeNull();
  });
});
