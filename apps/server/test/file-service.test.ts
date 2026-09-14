import { describe, expect, it } from 'vitest';
import { classifyFileType, normalizeFileName, normalizeMimeType } from '../src/file-service.js';

describe('file helpers', () => {
  it('normalizes safe names and rejects filesystem paths', () => {
    expect(normalizeFileName('  报告.pdf  ')).toBe('报告.pdf');
    expect(() => normalizeFileName('../secret')).toThrow();
    expect(() => normalizeFileName('folder\\secret')).toThrow();
    expect(() => normalizeFileName('\u0000')).toThrow();
  });

  it('prefers extension-derived MIME types and classifies common media', () => {
    expect(normalizeMimeType('photo.png', 'text/plain')).toBe('image/png');
    expect(classifyFileType({ kind: 'file', mimeType: 'image/png' })).toBe('image');
    expect(classifyFileType({ kind: 'file', mimeType: 'application/pdf' })).toBe('document');
    expect(classifyFileType({ kind: 'folder', mimeType: null })).toBe('folder');
  });
});
