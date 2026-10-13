import { memo, useMemo, type JSX } from 'react';
import {
  Eye,
  UploadCloud,
  Pencil,
  Download,
  FileEdit,
  Share2,
  type LucideIcon,
} from 'lucide-react';
import type { PermissionSet } from '../../types';

export type PermissionKey = keyof PermissionSet;

export interface PermissionDefinition {
  key: PermissionKey;
  title: string;
  description: string;
  icon: LucideIcon;
}

export const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  { key: 'read', title: '读取', description: '浏览与预览', icon: Eye },
  { key: 'upload', title: '上传', description: '上传与创建', icon: UploadCloud },
  { key: 'edit', title: '编辑', description: '重命名、移动、复制、删除', icon: Pencil },
  { key: 'download', title: '下载', description: '获取文件内容', icon: Download },
  { key: 'editMd', title: 'Markdown', description: '在线修改 MD', icon: FileEdit },
  { key: 'share', title: '分享', description: '创建公开分享链接', icon: Share2 },
];

export interface PermissionCardProps {
  permission: PermissionDefinition;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  clickable?: boolean;
}

/** 单个权限卡片：点击切换权限，适合放在权限矩阵/卡片墙中。 */
export const PermissionCard = memo(function PermissionCard({
  permission,
  value,
  onChange,
  disabled,
  clickable = true,
}: PermissionCardProps) {
  const Icon = permission.icon;
  return (
    <button
      type="button"
      className={`permission-card ${value ? 'is-on' : ''} ${disabled ? 'is-disabled' : ''}`}
      onClick={() => {
        if (!disabled && clickable) onChange(!value);
      }}
      aria-pressed={value}
      aria-label={`${permission.title} ${value ? '已开启' : '已关闭'}`}
      disabled={disabled}
    >
      <span className="permission-card__icon">
        <Icon size={18} />
      </span>
      <span className="permission-card__text">
        <strong>{permission.title}</strong>
        <small>{permission.description}</small>
      </span>
      <span className="permission-card__state">{value ? '开' : '关'}</span>
    </button>
  );
});

interface PermissionGridProps {
  permissions: PermissionSet;
  onChange: (permissions: PermissionSet) => void;
  permissionsDef?: PermissionDefinition[];
  disabled?: boolean;
  clickable?: boolean;
}

/** 权限卡片墙：六维权限以卡片形式展示，支持点击切换。 */
export function PermissionGrid({
  permissions,
  onChange,
  permissionsDef = PERMISSION_DEFINITIONS,
  disabled,
  clickable = true,
}: PermissionGridProps) {
  const handleChange = useMemo(() => {
    return (key: PermissionKey, value: boolean) => {
      onChange({ ...permissions, [key]: value });
    };
  }, [permissions, onChange]);

  return (
    <div className="permission-grid">
      {permissionsDef.map((def) => (
        <PermissionCard
          key={def.key}
          permission={def}
          value={permissions[def.key]}
          onChange={(value) => handleChange(def.key, value)}
          disabled={disabled}
          clickable={clickable}
        />
      ))}
    </div>
  );
}

export function permissionSummaryText(permissions: PermissionSet): string {
  const enabled = PERMISSION_DEFINITIONS.filter((d) => permissions[d.key]);
  return enabled.length ? enabled.map((d) => d.title).join(' / ') : '无';
}
