import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Droplets,
  Eye,
  LoaderCircle,
  Lock,
  RefreshCw,
  Save,
  Type,
} from 'lucide-react';
import { api } from '../../api/client';
import { Toast } from '../../components/Toast';
import { errorMessage } from '../../utils/format';
import type {
  WatermarkConfig,
  WatermarkCorner,
  WatermarkPosition,
} from '../../types';
import { usePanelToast } from './usePanelToast';

const PLACEHOLDER_HELP: Array<[string, string]> = [
  ['{username}', '当前账号'],
  ['{date}', '日期（2026-09-22）'],
  ['{time}', '时间（16:05:00）'],
  ['{datetime}', '日期 + 时间'],
  ['{shareCode}', '分享短码（仅分享链接）'],
  ['{fileName}', '文件名（仅 MD→PDF 导出）'],
];

const CORNER_LABELS: Record<WatermarkCorner, string> = {
  northwest: '左上',
  northeast: '右上',
  southwest: '左下',
  southeast: '右下',
};

function Showcase({ config }: { config: WatermarkConfig }) {
  const text = config.text || '{username} {datetime}';
  return (
    <div className="wm-panel__showcase" aria-hidden="true">
      <div className="wm-panel__showcase-photo" />
      <div
        className="wm-panel__showcase-mark"
        style={{
          opacity: Math.min(1, Math.max(0, config.opacity)),
          fontSize: `${Math.min(20, config.fontSize)}px`,
          color: config.color,
        }}
      >
        {text.replace(/\{[^}]+\}/g, '示例')}
      </div>
      <span className="wm-panel__showcase-tag">预览示意（实际以服务端输出为准）</span>
    </div>
  );
}

export function WatermarkConfigPanel() {
  const { toast, showToast, dismissToast } = usePanelToast();
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: ['admin-watermark-config'],
    queryFn: api.getWatermarkConfig,
    staleTime: 30_000,
  });

  const [draft, setDraft] = useState<WatermarkConfig | null>(null);

  // 服务端配置到达后初始化草稿
  useEffect(() => {
    if (draft === null && configQuery.data) {
      setDraft(configQuery.data.config);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configQuery.data]);

  const save = useMutation({
    mutationFn: (config: WatermarkConfig) => api.updateWatermarkConfig(config),
    onSuccess: ({ config }) => {
      setDraft(config);
      void queryClient.setQueryData(['admin-watermark-config'], { config });
      showToast('水印配置已保存并即时生效');
    },
  });

  const patch = (next: Partial<WatermarkConfig>) => {
    setDraft((current) => (current ? { ...current, ...next } : current));
  };

  if (configQuery.isLoading && draft === null) {
    return <div className="panel-loading"><LoaderCircle className="spin" size={20} /> 加载水印配置…</div>;
  }
  if (configQuery.isError && draft === null) {
    return <div className="notice notice--error" role="alert">{errorMessage(configQuery.error)}</div>;
  }
  if (draft === null) return null;

  const dirty = configQuery.data ? JSON.stringify(configQuery.data.config) !== JSON.stringify(draft) : true;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (dirty && !save.isPending) save.mutate(draft);
  };

  return (
    <div className="wm-panel">
      <div className="permission-note">
        <Droplets size={20} />
        <div>
          <strong>动态防泄密水印</strong>
          <span>
            配置保存后即时生效，无需重启；可作用于图像预览/下载与 Markdown 导出 PDF。
            在线的图片预览与下载会叠加身份水印，分享链接会叠加分享者与分享短码，实现外发溯源。
          </span>
        </div>
      </div>

      <form className="wm-panel__form" onSubmit={submit}>
        <div className="wm-panel__row wm-panel__row--switches">
          <label className="invite-permission-option">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
            <span>启用水印（总开关）</span>
          </label>
          <label className="invite-permission-option">
            <input
              type="checkbox"
              checked={draft.applyToPreview}
              onChange={(event) => patch({ applyToPreview: event.target.checked })}
            />
            <span>作用于图像预览（/stream）</span>
          </label>
          <label className="invite-permission-option">
            <input
              type="checkbox"
              checked={draft.applyToDownload}
              onChange={(event) => patch({ applyToDownload: event.target.checked })}
            />
            <span>作用于图像下载（/download）</span>
          </label>
        </div>

        <div className="wm-panel__grid">
          <label className="field wm-panel__field--wide">
            <span>水印文案模板</span>
            <input
              type="text"
              value={draft.text}
              maxLength={200}
              disabled={!draft.enabled}
              onChange={(event) => patch({ text: event.target.value })}
              placeholder="{username} {datetime}"
            />
            <small className="field-hint">支持占位符：{PLACEHOLDER_HELP.map(([token, label]) => `${token}（${label}）`).join('、')}</small>
          </label>

          <label className="field">
            <span>透明度（0–1）</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={draft.opacity}
              disabled={!draft.enabled}
              onChange={(event) => patch({ opacity: Number(event.target.value) })}
            />
          </label>

          <label className="field">
            <span>颜色</span>
            <div className="wm-panel__color">
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(draft.color) ? draft.color : '#3f4a5a'}
                disabled={!draft.enabled}
                onChange={(event) => patch({ color: event.target.value })}
              />
              <input
                type="text"
                value={draft.color}
                maxLength={7}
                disabled={!draft.enabled}
                onChange={(event) => patch({ color: event.target.value })}
              />
            </div>
          </label>

          <label className="field">
            <span>字号（px）</span>
            <input
              type="number"
              min={8}
              max={200}
              value={draft.fontSize}
              disabled={!draft.enabled}
              onChange={(event) => patch({ fontSize: Number(event.target.value) })}
            />
          </label>

          <label className="field">
            <span>旋转角度（°）</span>
            <input
              type="number"
              min={-90}
              max={90}
              value={draft.angleDeg}
              disabled={!draft.enabled}
              onChange={(event) => patch({ angleDeg: Number(event.target.value) })}
            />
          </label>

          <label className="field">
            <span>布局方式</span>
            <select
              className="select-field"
              value={draft.position}
              disabled={!draft.enabled}
              onChange={(event) => patch({ position: event.target.value as WatermarkPosition })}
            >
              <option value="tile">平铺（推荐）</option>
              <option value="corner">角落单标</option>
            </select>
          </label>

          {draft.position === 'corner' ? (
            <>
              <label className="field">
                <span>角落方位</span>
                <select
                  className="select-field"
                  value={draft.corner}
                  disabled={!draft.enabled}
                  onChange={(event) => patch({ corner: event.target.value as WatermarkCorner })}
                >
                  {(Object.keys(CORNER_LABELS) as WatermarkCorner[]).map((corner) => (
                    <option key={corner} value={corner}>{CORNER_LABELS[corner]}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>距边缘（px）</span>
                <input
                  type="number"
                  min={0}
                  max={200}
                  value={draft.margin}
                  disabled={!draft.enabled}
                  onChange={(event) => patch({ margin: Number(event.target.value) })}
                />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>瓦片宽（px）</span>
                <input
                  type="number"
                  min={100}
                  max={2000}
                  value={draft.tileWidth}
                  disabled={!draft.enabled}
                  onChange={(event) => patch({ tileWidth: Number(event.target.value) })}
                />
              </label>
              <label className="field">
                <span>瓦片高（px）</span>
                <input
                  type="number"
                  min={100}
                  max={2000}
                  value={draft.tileHeight}
                  disabled={!draft.enabled}
                  onChange={(event) => patch({ tileHeight: Number(event.target.value) })}
                />
              </label>
              <label className="field">
                <span>瓦片间距（px）</span>
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={draft.tileSpacing}
                  disabled={!draft.enabled}
                  onChange={(event) => patch({ tileSpacing: Number(event.target.value) })}
                />
              </label>
            </>
          )}
        </div>

        <Showcase config={draft} />

        {save.isError ? (
          <div className="notice notice--error" role="alert">{errorMessage(save.error)}</div>
        ) : null}

        <div className="wm-panel__actions">
          <p className="user-details__note">
            <Lock size={14} /> 水印在服务端叠加，用户无法绕过；预览与下载受 <code>applyTo*</code> 开关控制。
            <Type size={14} /> 变更即刻生效，无需重启服务。
          </p>
          <div className="wm-panel__buttons">
            {dirty ? (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => configQuery.data && setDraft(configQuery.data.config)}
                disabled={save.isPending}
              >
                <RefreshCw size={15} /> 还原
              </button>
            ) : null}
            <button
              className="button button--primary"
              type="submit"
              disabled={!dirty || save.isPending}
            >
              {save.isPending ? <LoaderCircle className="spin" size={17} /> : <Save size={16} />}
              保存配置
            </button>
          </div>
        </div>
      </form>

      <p className="user-details__note">
        <Eye size={14} /> 关闭「水印（总开关）」可临时停用全部水印（不建议）；保存操作会记录到活动审计。
      </p>

      {toast ? <Toast message={toast} onDismiss={dismissToast} /> : null}
    </div>
  );
}
