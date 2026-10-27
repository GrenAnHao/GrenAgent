import { App, Tooltip } from 'antd';
import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useFilePathModeStore } from '../../stores/filePathModeStore';
import { summarizePaths, splitPathForDisplay } from './filePathDisplay';
import { fileExplorerStyles as styles } from './fileExplorerStyles';

export interface FilePathBarProps {
  root: string | null;
  /** 鼠标停在文件树哪一行；有就优先显示它。 */
  hoverPath: string | null;
  /** 当前选中的（正在查看的）文件。目前文件树是单选，数组留给多选。 */
  selectedPaths: readonly string[];
}

const COPIED_MS = 1500;

/**
 * 文件树底部的路径栏：悬停项优先，没有悬停就显示选中项。
 * 默认相对项目根，可切到绝对路径（偏好全局记住）。栏里放不下时省略号只吃目录部分，文件名始终完整；
 * 完整值在悬停提示里，「复制」复制的是栏里当前这一行（多项时一行一个）。
 */
export function FilePathBar({ root, hoverPath, selectedPaths }: FilePathBarProps) {
  const { message } = App.useApp();
  const mode = useFilePathModeStore((state) => state.mode);
  const setMode = useFilePathModeStore((state) => state.setMode);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const paths = hoverPath ? [hoverPath] : selectedPaths;
  const summary = summarizePaths(root, paths, mode);
  const { dir, name } = splitPathForDisplay(summary.text);
  const empty = summary.count === 0;

  const copy = () => {
    if (empty) return;
    navigator.clipboard.writeText(summary.copy).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => void message.error('复制失败，剪贴板不可用'),
    );
  };

  return (
    <div className={styles.pathBar} data-testid="file-path-bar">
      <Tooltip title={empty ? null : <span className={styles.pathTip}>{summary.full}</span>} placement="topLeft">
        <span
          className={styles.pathText}
          data-testid="file-path-text"
          data-hover={hoverPath ? 'true' : undefined}
          data-full-path={summary.full}
        >
          {empty ? (
            <span className={styles.pathEmpty}>悬停或选择文件查看路径</span>
          ) : (
            <>
              {dir ? <span className={styles.pathDir}>{dir}</span> : null}
              <span className={styles.pathName}>{name}</span>
            </>
          )}
        </span>
      </Tooltip>
      <Tooltip title={mode === 'relative' ? '当前：相对项目根，点击改为绝对路径' : '当前：绝对路径，点击改为相对项目根'}>
        <button
          type="button"
          className={styles.pathButton}
          data-testid="file-path-mode"
          data-mode={mode}
          aria-label={mode === 'relative' ? '显示绝对路径' : '显示相对路径'}
          onClick={() => setMode(mode === 'relative' ? 'absolute' : 'relative')}
        >
          {mode === 'relative' ? '相对' : '绝对'}
        </button>
      </Tooltip>
      <Tooltip title={copied ? '已复制' : '复制路径'}>
        <button
          type="button"
          className={styles.pathButton}
          data-testid="file-path-copy"
          aria-label="复制路径"
          disabled={empty}
          onClick={copy}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </Tooltip>
    </div>
  );
}
