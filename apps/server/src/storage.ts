import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
} from 'node:fs';
import {
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { notFound, payloadTooLarge, storageError } from './errors.js';
import type { StoredObject } from './types.js';

const objectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class LocalObjectStorage {
  constructor(
    private readonly objectDir: string,
    private readonly uploadDir: string,
  ) {
    mkdirSync(objectDir, { recursive: true });
    mkdirSync(uploadDir, { recursive: true });
  }

  async storeStream(stream: Readable, maxBytes: number): Promise<StoredObject> {
    const objectId = randomUUID();
    const temporaryPath = join(this.uploadDir, `${objectId}.upload`);
    const objectPath = this.pathForObjectId(objectId);
    let sizeBytes = 0;
    const hash = createHash('sha256');

    const countingTransform = new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += buffer.length;
        if (sizeBytes > maxBytes) {
          callback(payloadTooLarge());
          return;
        }
        hash.update(buffer);
        callback(null, buffer);
      },
    });

    try {
      await pipeline(stream, countingTransform, createWriteStream(temporaryPath, { flags: 'wx' }));
      mkdirSync(dirname(objectPath), { recursive: true });
      await rename(temporaryPath, objectPath);
      return {
        objectId,
        path: objectPath,
        sizeBytes,
        sha256: hash.digest('hex'),
      };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof Error && error.name === 'AppError') throw error;
      if ((error as { statusCode?: number }).statusCode === 413) throw payloadTooLarge();
      throw storageError('上传文件写入失败', error instanceof Error ? error.message : error);
    }
  }

  pathForObjectId(objectId: string): string {
    if (!objectIdPattern.test(objectId)) {
      throw storageError('无效的文件对象标识');
    }
    return join(this.objectDir, objectId.slice(0, 2), `${objectId}.blob`);
  }

  read(objectId: string, options?: { start?: number; end?: number }): Readable {
    return createReadStream(this.pathForObjectId(objectId), options);
  }

  async stat(objectId: string) {
    return stat(this.pathForObjectId(objectId));
  }

  /**
   * 读取对象为内存缓冲（文本内容/预览用）。超过 maxBytes 时截断并标记 truncated，
   * 防止大文件拖垮内存；对象缺失抛 404。
   */
  async readBytes(objectId: string, maxBytes: number): Promise<{ data: Buffer; truncated: boolean }> {
    const stream = this.read(objectId);
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = maxBytes + 1 - total;
        if (buffer.length >= remaining) {
          chunks.push(buffer.subarray(0, Math.max(0, remaining)));
          truncated = true;
          stream.destroy();
          break;
        }
        chunks.push(buffer);
        total += buffer.length;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('文件内容');
      throw storageError('读取文件内容失败', error instanceof Error ? error.message : error);
    }
    return { data: Buffer.concat(chunks), truncated };
  }

  /** 直接覆盖写入对象（在线编辑文本/MD 用）；返回新的大小与 sha256。 */
  async writeObject(objectId: string, data: Buffer): Promise<{ sizeBytes: number; sha256: string }> {
    const objectPath = this.pathForObjectId(objectId);
    try {
      mkdirSync(dirname(objectPath), { recursive: true });
      await writeFile(objectPath, data);
      return {
        sizeBytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      };
    } catch (error) {
      throw storageError('写入文件内容失败', error instanceof Error ? error.message : error);
    }
  }

  async remove(objectId: string): Promise<void> {
    try {
      await unlink(this.pathForObjectId(objectId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw storageError('删除文件内容失败', error instanceof Error ? error.message : error);
      }
    }
  }

  /** Remove upload fragments left behind by an interrupted process. */
  async cleanupTemporaryUploads(): Promise<number> {
    try {
      const entries = await readdir(this.uploadDir, { withFileTypes: true });
      let removed = 0;
      await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.endsWith('.upload')) return;
        await unlink(join(this.uploadDir, entry.name));
        removed += 1;
      }));
      return removed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw storageError('清理临时上传失败', error instanceof Error ? error.message : error);
    }
  }

  /** Remove orphaned .blob objects that are not referenced by active file metadata. */
  async removeOrphans(activeObjectIds: Set<string>): Promise<number> {
    let removed = 0;
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      await Promise.all(entries.map(async (entry) => {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath);
          return;
        }
        if (!entry.isFile() || !entry.name.endsWith('.blob')) return;
        const objectId = entry.name.slice(0, -'.blob'.length);
        if (!activeObjectIds.has(objectId)) {
          await unlink(fullPath);
          removed += 1;
        }
      }));
    };
    try {
      await visit(this.objectDir);
    } catch (error) {
      throw storageError('清理孤立文件失败', error instanceof Error ? error.message : error);
    }
    return removed;
  }
}
