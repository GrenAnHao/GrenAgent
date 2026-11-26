import { useEffect, useRef, useState } from 'react';
import { Button, Input, Select, type InputRef, type RefSelectProps } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { FolderOpen, Plus, Search } from 'lucide-react';
import { pathKey } from '../../lib/pathUtils';
import type { ProjectOption } from './useProjectOptions';
import { IndexBadge } from './CodeProjectHome';
import { directoryView, type IndexEntry } from './useIndexDirectory';

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    padding-block: 3px;
    > svg {
      flex: none;
      color: ${cssVar.colorTextTertiary};
    }
  `,
  left: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    > span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    > span:last-child {
      font-size: 12px;
      color: ${cssVar.colorTextSecondary};
    }
  `,
  display: css`
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 6px;
    > svg {
      flex: none;
    }
    > span {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    > small {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: ${cssVar.colorTextTertiary};
    }
  `,
  filter: css`
    padding: 4px 4px 7px;
  `,
}));

export function CodeProjectList({
  options,
  project,
  entries,
  onSelect,
  onAdd,
}: {
  options: ProjectOption[];
  project: string;
  entries: Record<string, IndexEntry>;
  onSelect: (path: string) => void;
  onAdd: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  const input = useRef<InputRef>(null);
  const selector = useRef<RefSelectProps>(null);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const needle = filter.trim().replaceAll('\\', '/').toLowerCase();
  const matching = options.filter((o) => (o.name + ' ' + o.cwd).replaceAll('\\', '/').toLowerCase().includes(needle));
  function toggle(next: boolean) {
    setOpen(next);
    if (!next) setFilter('');
  }
  function choose(value: string) {
    toggle(false);
    onSelect(value);
  }
  return (
    <Select
      ref={selector}
      aria-label="项目"
      placeholder="请选择项目"
      value={project || undefined}
      open={open}
      onOpenChange={toggle}
      onChange={choose}
      virtual={false}
      optionLabelProp="display"
      style={{ width: '100%', minWidth: 0 }}
      notFoundContent="没有匹配的项目"
      popupRender={(menu) => (
        <>
          <div className={styles.filter}>
            <Input
              ref={input}
              aria-label="过滤项目"
              placeholder="搜索项目名称或路径"
              prefix={<Search size={14} />}
              allowClear
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') {
                  toggle(false);
                  selector.current?.focus();
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  selector.current?.focus();
                }
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && matching[0]) {
                  e.preventDefault();
                  choose(matching[0].cwd);
                }
              }}
            />
          </div>
          {menu}
          <Button
            block
            type="text"
            icon={<Plus size={14} />}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              toggle(false);
              onAdd();
            }}
          >
            添加本地项目
          </Button>
        </>
      )}
      options={matching.map((option) => {
        const entry = entries[pathKey(option.cwd)];
        return {
          value: option.cwd,
          title: option.name + ' · ' + option.cwd + '（' + directoryView(entry).label + '）',
          display: (
            <span className={styles.display}>
              <FolderOpen size={14} />
              <span>{option.name}</span>
              <small>{' · ' + option.cwd}</small>
            </span>
          ),
          label: (
            <span className={styles.row}>
              <FolderOpen size={15} />
              <span className={styles.left}>
                <span>{option.name}</span>
                <span>{option.cwd}</span>
              </span>
              <IndexBadge entry={entry} />
            </span>
          ),
        };
      })}
    />
  );
}
