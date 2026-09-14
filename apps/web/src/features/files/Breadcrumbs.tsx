import { ChevronRight, Home } from 'lucide-react';
import type { FileRecord } from '../../types';

interface BreadcrumbsProps {
  path: FileRecord[];
  onNavigate: (id: string | null) => void;
}

export function Breadcrumbs({ path, onNavigate }: BreadcrumbsProps) {
  return (
    <nav className="breadcrumbs" aria-label="当前目录">
      <button type="button" onClick={() => onNavigate(null)} aria-label="根目录">
        <Home size={17} aria-hidden="true" />
        <span>全部文件</span>
      </button>
      {path.map((item, index) => (
        <span className="breadcrumbs__segment" key={item.id}>
          <ChevronRight size={15} aria-hidden="true" />
          <button
            type="button"
            onClick={() => onNavigate(item.id)}
            aria-current={index === path.length - 1 ? 'page' : undefined}
          >
            {item.name}
          </button>
        </span>
      ))}
    </nav>
  );
}
