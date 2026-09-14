import { describe, expect, it } from 'vitest';
import { fileTypeOf, formatBytes } from './format';

describe('web formatting helpers', () => {
  it('formats byte sizes for compact file metadata', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB');
  });

  it('classifies media consistently with the server', () => {
    expect(fileTypeOf({ kind: 'folder', mimeType: null })).toBe('folder');
    expect(fileTypeOf({ kind: 'file', mimeType: 'video/mp4' })).toBe('video');
    expect(fileTypeOf({ kind: 'file', mimeType: 'application/pdf' })).toBe('document');
    expect(fileTypeOf({ kind: 'file', mimeType: 'application/octet-stream' })).toBe('other');
  });
});
