import {
  ArrowDownAZ,
  ArrowUpAZ,
  FolderPlus,
  Grid2X2,
  List,
  Search,
  Upload,
} from 'lucide-react';
import type { FileType, SortField, SortOrder } from '../../types';

interface FileToolbarProps {
  search: string;
  onSearch: (value: string) => void;
  type: FileType | '';
  onTypeChange: (value: FileType | '') => void;
  sort: SortField;
  onSortChange: (value: SortField) => void;
  order: SortOrder;
  onOrderChange: (value: SortOrder) => void;
  view: 'list' | 'grid';
  onViewChange: (value: 'list' | 'grid') => void;
  onCreateFolder: () => void;
  onFilesSelected: (files: File[]) => void;
  canUpload: boolean;
  disabled?: boolean;
}

export function FileToolbar(props: FileToolbarProps) {
  return (
    <div className="file-toolbar">
      <div className="search-field">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          value={props.search}
          onChange={(event) => props.onSearch(event.target.value)}
          placeholder="搜索当前目录"
          aria-label="搜索当前目录"
        />
      </div>

      <div className="toolbar-controls">
        <label className="select-control">
          <span className="sr-only">文件类型</span>
          <select value={props.type} onChange={(event) => props.onTypeChange(event.target.value as FileType | '')}>
            <option value="">全部类型</option>
            <option value="folder">文件夹</option>
            <option value="document">文档</option>
            <option value="image">图片</option>
            <option value="audio">音频</option>
            <option value="video">视频</option>
            <option value="other">其他</option>
          </select>
        </label>
        <label className="select-control">
          <span className="sr-only">排序字段</span>
          <select value={props.sort} onChange={(event) => props.onSortChange(event.target.value as SortField)}>
            <option value="createdAt">创建时间</option>
            <option value="updatedAt">修改时间</option>
            <option value="name">名称</option>
            <option value="size">大小</option>
          </select>
        </label>
        <button
          className="icon-button icon-button--bordered"
          type="button"
          onClick={() => props.onOrderChange(props.order === 'asc' ? 'desc' : 'asc')}
          aria-label={props.order === 'asc' ? '当前升序，点击改为降序' : '当前降序，点击改为升序'}
          title={props.order === 'asc' ? '升序' : '降序'}
        >
          {props.order === 'asc' ? <ArrowUpAZ size={18} /> : <ArrowDownAZ size={18} />}
        </button>
        <div className="segmented" aria-label="显示方式">
          <button
            type="button"
            className={props.view === 'list' ? 'is-active' : ''}
            onClick={() => props.onViewChange('list')}
            aria-label="列表显示"
            aria-pressed={props.view === 'list'}
          ><List size={18} /></button>
          <button
            type="button"
            className={props.view === 'grid' ? 'is-active' : ''}
            onClick={() => props.onViewChange('grid')}
            aria-label="网格显示"
            aria-pressed={props.view === 'grid'}
          ><Grid2X2 size={17} /></button>
        </div>
      </div>

      {props.canUpload ? <div className="toolbar-actions">
        <button className="button button--secondary" type="button" onClick={props.onCreateFolder} disabled={props.disabled}>
          <FolderPlus size={18} />
          <span>新建文件夹</span>
        </button>
        <label
          className={`button button--primary upload-picker${props.disabled ? ' is-disabled' : ''}`}
          aria-disabled={props.disabled}
        >
          <Upload size={18} />
          <span>上传文件</span>
          <input
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            disabled={props.disabled}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              if (files.length > 0) props.onFilesSelected(files);
            }}
          />
        </label>
      </div> : null}
    </div>
  );
}
