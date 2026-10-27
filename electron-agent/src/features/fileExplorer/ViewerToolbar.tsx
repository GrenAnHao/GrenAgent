import { Breadcrumb, Button, Segmented, Tag, Tooltip } from 'antd';
import { ArrowLeft, ArrowRight, Diff, ExternalLink, RefreshCw, Save } from 'lucide-react';
import { formatBytes } from '../devtools/devtoolsFormat';
import { fileExplorerStyles as styles } from './fileExplorerStyles';
import type { ViewMode } from './useOpenFile';

/** 面包屑最多显示末尾几级；完整路径在悬停提示和文件树底部的路径栏里。 */
const CRUMB_LEVELS = 2;

export interface ViewerNav {
  canBack: boolean;
  canForward: boolean;
  refreshing: boolean;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
}

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
  /** 没有打开文件（空闲 / 加载中 / 出错）时不给「用系统打开」。 */
  onOpenExternal?: () => void;
  nav: ViewerNav;
}

export function ViewerToolbar(props: ViewerToolbarProps) {
  const { segments, size, truncated, modeSwitch, dirty, saving, diff, nav } = props;
  const collapsed = segments.length > CRUMB_LEVELS;
  const shown = collapsed ? ['…', ...segments.slice(-CRUMB_LEVELS)] : segments;
  const crumbs = (
    <Breadcrumb
      className={styles.crumbs}
      data-testid="file-viewer-path"
      items={shown.map((title, index) => ({ key: `${index}:${title}`, title }))}
    />
  );
  return (
    <div className={styles.toolbar} data-testid="file-viewer-toolbar">
      <div className={styles.navButtons} data-testid="file-viewer-nav">
        <Tooltip title="后退（Alt+←）">
          <Button
            size="small"
            type="text"
            data-testid="file-nav-back"
            aria-label="后退"
            disabled={!nav.canBack}
            icon={<ArrowLeft size={14} />}
            onClick={nav.onBack}
          />
        </Tooltip>
        <Tooltip title="前进（Alt+→）">
          <Button
            size="small"
            type="text"
            data-testid="file-nav-forward"
            aria-label="前进"
            disabled={!nav.canForward}
            icon={<ArrowRight size={14} />}
            onClick={nav.onForward}
          />
        </Tooltip>
        <Tooltip title="刷新文件和文件树（F5）">
          <Button
            size="small"
            type="text"
            data-testid="file-nav-refresh"
            aria-label="刷新"
            aria-busy={nav.refreshing}
            icon={<RefreshCw size={14} className={nav.refreshing ? styles.spin : undefined} />}
            onClick={nav.onRefresh}
          />
        </Tooltip>
      </div>
      {collapsed ? <Tooltip title={segments.join('/')}>{crumbs}</Tooltip> : crumbs}
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
        {props.onOpenExternal ? (
          <Tooltip title="用系统默认程序打开">
            <Button size="small" type="text" data-testid="file-open-external" icon={<ExternalLink size={14} />} onClick={props.onOpenExternal} />
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
