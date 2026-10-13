/**
 * 分享链接（v0.1.2 M6）前端辅助函数。
 * 类型与 API 方法以 `apps/web/src/types.ts` / `apps/web/src/api/client.ts` 为准。
 */

import type { FileRecord, ShareLink, ShareTreeNode } from '../../types';

/** 分享链接状态（前端按 ShareLink 字段推导，用于状态徽标） */
export type ShareLinkStatus = 'active' | 'revoked' | 'expired' | 'exhausted';

/** 状态推导：撤销 > 过期 > 次数用尽 > 有效 */
export function shareLinkStatus(share: ShareLink): ShareLinkStatus {
  if (share.isRevoked) return 'revoked';
  if (share.expired) return 'expired';
  if (share.maxAccesses !== null && share.accessCount >= share.maxAccesses) return 'exhausted';
  return 'active';
}

/**
 * 把分享树节点适配成共享的 FileRecord 形状，
 * 以便复用 FileTypeIcon / fileTypeOf 等既有组件（不修改它们）。
 * 占位字段（objectId/sha256/时间等）不会被这些组件读取。
 */
export function toFileRecord(node: ShareTreeNode): FileRecord {
  return {
    id: node.id,
    parentId: null,
    name: node.name,
    kind: node.kind,
    objectId: null,
    mimeType: node.mimeType,
    extension: node.extension,
    sizeBytes: node.sizeBytes,
    sha256: null,
    isShared: false,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  };
}

/**
 * 公开接口目标地址：文件夹分享内按相对路径（ShareTreeNode.path）定位子文件。
 * 文件分享（根文件）不需要 path 参数，直接使用 publicShareStreamUrl / publicShareDownloadUrl。
 */
export function publicTargetUrl(base: string, node: ShareTreeNode): string {
  return `${base}?path=${encodeURIComponent(node.path)}`;
}

/** 判断分享节点 / 文件记录是否为 Markdown（公开分享端将渲染为带水印 PDF）。 */
export function isMarkdownMeta(file: { name?: string; extension?: string | null; mimeType?: string | null }): boolean {
  return /\.(md|markdown)$/i.test(file.name ?? file.extension ?? '')
    || file.mimeType === 'text/markdown';
}
