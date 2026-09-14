import {
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  type LucideIcon,
} from 'lucide-react';
import type { FileRecord, FileType } from '../types';
import { fileTypeOf } from '../utils/format';

const icons: Record<FileType, LucideIcon> = {
  folder: Folder,
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  document: FileText,
  other: FileArchive,
};

export function FileTypeIcon({ file, size = 22 }: { file: FileRecord; size?: number }) {
  const type = fileTypeOf(file);
  const Icon = icons[type];
  return (
    <span className={`file-type-icon file-type-icon--${type}`} aria-hidden="true">
      <Icon size={size} strokeWidth={1.8} />
    </span>
  );
}
