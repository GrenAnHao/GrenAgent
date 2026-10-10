import { Breadcrumb, Button, Segmented, Tag, Tooltip } from 'antd';
import { Diff, ExternalLink, Save } from 'lucide-react';
import { formatBytes } from '../devtools/devtoolsFormat';
import { fileExplorerStyles as styles } from './fileExplorerStyles';
import type { ViewMode } from './useOpenFile';

export interface ViewerToolbarProps {
  segments: string[];
  size: number | null;
  truncated: boolean;
  /** 只有文本文件有预览 / 编辑切换；markdown 叫「预览」，其余叫「只读」。 */
  modeSwitch: { mode: ViewMode; previewLabel: string; disabled: boolean } | null;
  onModeChange: (mode: ViewMode) => void;
  dirty: boolean;
  saving: boolean;
  /** 编辑模式下才出现「对比」。 */
  diff: { active: boolean; disabled: boolean } | null;
  onToggleDiff: () => void;
  onSave: () => void;
  onOpenExternal: () => void;
}

export function ViewerToolbar(props: ViewerToolbarProps) {
  const { segments, size, truncated, modeSwitch, dirty, saving, diff } = props;
  return (
    <div className={styles.toolbar} data-testid="file-viewer-toolbar">
      <Breadcrumb
        className={styles.crumbs}
        data-testid="file-viewer-path"
        items={segments.map((title, index) => ({ key: `${index}:${title}`, title }))}
      />
      {dirty ? <span className={styles.dirtyDot} data-testid="file-dirty-dot" title="有未保存的修改" /> : null}
      {size !== null ? <span className={styles.meta}>{formatBytes(size)}</span> : null}
      {truncated ? (
        <Tag color="warning" data-testid="file-truncated-tag" style={{ marginInlineEnd: 0 }}>
          已截断
        </Tag>
      ) : null}
      <div className={styles.actions}>
        {modeSwitch ? (
          <Segmented
            size="small"
            data-testid="file-mode-switch"
            value={modeSwitch.mode}
            disabled={modeSwitch.disabled}
            options={[
              { label: modeSwitch.previewLabel, value: 'preview' },
              { label: '编辑', value: 'edit' },
            ]}
            onChange={(value) => props.onModeChange(value as ViewMode)}
          />
        ) : null}
        {diff ? (
          <Tooltip title="和磁盘上的版本对比">
            <Button
              size="small"
              data-testid="file-diff-toggle"
              type={diff.active ? 'primary' : 'default'}
              ghost={diff.active}
              disabled={diff.disabled}
              icon={<Diff size={14} />}
              onClick={props.onToggleDiff}
            >
              对比
            </Button>
          </Tooltip>
        ) : null}
        {modeSwitch ? (
          <Tooltip title="保存（Ctrl+S）">
            <Button
              size="small"
              type="primary"
              data-testid="file-save"
              disabled={!dirty}
              loading={saving}
              icon={<Save size={14} />}
              onClick={props.onSave}
            >
              保存
            </Button>
          </Tooltip>
        ) : null}
        <Tooltip title="用系统默认程序打开">
          <Button size="small" type="text" data-testid="file-open-external" icon={<ExternalLink size={14} />} onClick={props.onOpenExternal} />
        </Tooltip>
      </div>
    </div>
  );
}
