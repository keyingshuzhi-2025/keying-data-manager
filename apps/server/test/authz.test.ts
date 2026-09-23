import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { HubDatabase } from '../src/db/database.js';
import {
  allPermissions,
  legacyPermissionsForUser,
  noPermissions,
  resolveConfiguredPermissionSource,
  resolveEffectivePermissions,
  resolvePermissionSource,
  ROOT_FOLDER_ID,
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
    const legacyUser = makeUser({ permissions: perms({ read: true }) });
    insertFolder('f1', null);
    const resolution = resolvePermissionSource(db.sqlite, legacyUser, { kind: 'folder', id: 'f1' });
    expect(resolution.source).toBe('legacy');
    // download 跟随 read（历史行为）；editMd/share 默认关闭
    expect(resolution.permissions).toEqual(perms({ read: true, download: true }));
  });

  it('根目录默认策略（ROOT）对根目录目标生效（source=root）', () => {
    const user = makeUser(); // 遗留权限全关
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
    const user = makeUser();
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
    const db2 = db;
    insertFolder('f1', null);
    const source = resolveConfiguredPermissionSource(db2.sqlite, { kind: 'folder', id: 'f1' });
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
});
