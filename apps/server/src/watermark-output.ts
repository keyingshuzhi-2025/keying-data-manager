/**
 * 服务端图像水印输出辅助（v0.1.2 §6.2 / §3.4）。
 *
 * 在内部（身份水印）与公开分享（分享溯源水印）的图像下载/预览路径上复用：
 * 命中「图像 + 配置启用 + 对应输出方向开启」时读取对象并叠加水印，返回重编码字节；
 * 其余情况返回 null，由调用方按原样输出（文本/媒体/文档不受影响）。
 *
 * 水印合成失败（sharp 无法解码等）时优雅回退为原样输出（记日志），
 * 避免破坏图像可用性；常见格式 png/jpeg/webp/avif/gif/svg 均受支持。
 */
import { watermarkImage, WatermarkError, type WatermarkContext } from './watermark.js';
import {
  watermarkStyleFromConfig,
  type WatermarkConfig,
} from './watermark-config.js';
import type { LocalObjectStorage } from './storage.js';

export interface WatermarkOutputFile {
  name: string;
  mimeType: string | null;
  objectId: string | null;
}

export interface WatermarkOutputResult {
  data: Buffer;
  mimeType: string;
  label: string;
}

/**
 * 尝试为图像文件生成水印版本。
 * @returns 水印后的字节与 MIME；不适用（非图像/未启用/方向关闭/失败）时返回 null。
 */
export async function maybeWatermarkImage(
  file: WatermarkOutputFile,
  storage: LocalObjectStorage,
  config: WatermarkConfig,
  context: WatermarkContext,
  apply: 'preview' | 'download',
): Promise<WatermarkOutputResult | null> {
  if (!file.objectId) return null;
  const mime = (file.mimeType ?? '').toLowerCase();
  if (!mime.startsWith('image/')) return null;
  if (!config.enabled) return null;
  if (apply === 'preview' && !config.applyToPreview) return null;
  if (apply === 'download' && !config.applyToDownload) return null;

  const { data } = await storage.readBytes(file.objectId, Number.MAX_SAFE_INTEGER);
  if (data.length === 0) return null;

  try {
    const result = await watermarkImage({
      input: data,
      mimeType: file.mimeType ?? undefined,
      context: { ...context, fileName: file.name },
      text: config.text,
      style: watermarkStyleFromConfig(config),
    });
    return { data: result.data, mimeType: result.mimeType, label: result.label };
  } catch (error) {
    if (error instanceof WatermarkError) {
      // 优雅降级：无法水印的图像按原样输出
      return null;
    }
    throw error;
  }
}
