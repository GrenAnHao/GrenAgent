import { FileTypeIcon, MaterialFileTypeIcon } from '@lobehub/ui';
import { memo } from 'react';

import { mimeTypeMap } from './config';

interface FileIconProps {
  fileName: string;
  fileType?: string;
  isDirectory?: boolean;
  size?: number;
  variant?: 'raw' | 'file' | 'folder';
}

/** 按扩展名展示 Material / 彩色 Office 文件图标（对齐 LobeHub `@/components/FileIcon`）。 */
const FileIcon = memo<FileIconProps>(({ fileName, size, variant = 'raw', isDirectory }) => {
  if (isDirectory) {
    return (
      <MaterialFileTypeIcon
        fallbackUnknownType={false}
        filename={fileName}
        size={size}
        type="folder"
        variant={variant}
      />
    );
  }

  if (Object.keys(mimeTypeMap).some((key) => fileName?.toLowerCase().endsWith(`.${key}`))) {
    const ext = fileName.split('.').pop()?.toLowerCase() as string;
    return <FileTypeIcon color={mimeTypeMap[ext]} filetype={ext?.toUpperCase()} size={size} type="file" />;
  }

  return <MaterialFileTypeIcon filename={fileName} size={size} type="file" variant={variant} />;
});

FileIcon.displayName = 'FileIcon';

export default FileIcon;
