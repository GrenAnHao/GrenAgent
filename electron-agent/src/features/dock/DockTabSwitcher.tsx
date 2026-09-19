import { useMemo, useState } from 'react';
import { ActionIcon, Icon, Popover } from '@lobehub/ui';
import { ChevronDown, Search, X } from 'lucide-react';
import { useDockStore, type DockRegion, type DockTab } from '../../stores/dockStore';
import { dockTabKindIcon } from './dockKindIcon';
import { dockTabStyles } from './dockTabStyles';
import { formatClosedAgo } from './formatClosedAgo';

interface DockTabSwitcherProps {
  region: DockRegion;
  tabs: DockTab[];
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

function matchesQuery(title: string, query: string): boolean {
  return title.toLowerCase().includes(query);
}

export function DockTabSwitcher({ region, tabs, onActivate, onClose }: DockTabSwitcherProps) {
  const closedTabs = useDockStore((s) => s.closedTabs ?? []);
  const restoreClosedTab = useDockStore((s) => s.restoreClosedTab);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const openFiltered = useMemo(
    () => (q ? tabs.filter((t) => matchesQuery(t.title, q)) : tabs),
    [tabs, q],
  );
  const closedFiltered = useMemo(() => {
    const inRegion = closedTabs.filter((c) => c.region === region);
    return q ? inRegion.filter((c) => matchesQuery(c.title, q)) : inRegion;
  }, [closedTabs, region, q]);

  return (
    <Popover
      arrow={false}
      content={
        <div className={dockTabStyles.switcherPanel} data-testid={`dock-tab-switcher-${region}`}>
          <div className={dockTabStyles.menuSearch}>
            <Icon icon={Search} size={14} />
            <input
              className={dockTabStyles.menuSearchInput}
              placeholder="搜索标签页..."
              value={query}
              data-testid="dock-switcher-search"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {openFiltered.length > 0 ? (
            <>
              <div className={dockTabStyles.menuSection}>打开的标签页</div>
              {openFiltered.map((tab) => (
                <div
                  key={tab.id}
                  role="button"
                  tabIndex={0}
                  className={dockTabStyles.menuRow}
                  data-testid={`dock-switcher-open-${tab.id}`}
                  onClick={() => {
                    onActivate(tab.id);
                    setOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onActivate(tab.id);
                      setOpen(false);
                    }
                  }}
                >
                  <Icon icon={dockTabKindIcon(tab.kind)} size={14} />
                  <span className={dockTabStyles.menuLabel}>{tab.title}</span>
                  {tab.touchedAt ? (
                    <span className={dockTabStyles.menuMeta}>{formatClosedAgo(tab.touchedAt)}</span>
                  ) : null}
                  {tab.closable ? (
                    <span
                      className={dockTabStyles.menuClose}
                      role="button"
                      tabIndex={0}
                      title="关闭"
                      data-testid={`dock-switcher-close-${tab.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(tab.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          onClose(tab.id);
                        }
                      }}
                    >
                      <X size={12} />
                    </span>
                  ) : null}
                </div>
              ))}
            </>
          ) : null}
          {closedFiltered.length > 0 ? (
            <>
              <div className={dockTabStyles.menuSection}>最近关闭的标签页</div>
              {closedFiltered.map((entry) => (
                <button
                  key={`${entry.id}:${entry.closedAt}`}
                  type="button"
                  className={dockTabStyles.menuRow}
                  data-testid={`dock-switcher-closed-${entry.id}`}
                  onClick={() => {
                    restoreClosedTab(entry.id, entry.closedAt);
                    setOpen(false);
                  }}
                >
                  <Icon icon={dockTabKindIcon(entry.kind)} size={14} />
                  <span className={dockTabStyles.menuLabel}>{entry.title}</span>
                  <span className={dockTabStyles.menuMeta}>{formatClosedAgo(entry.closedAt)}</span>
                </button>
              ))}
            </>
          ) : null}
        </div>
      }
      open={open}
      placement="bottomLeft"
      trigger="click"
      styles={{ content: { padding: 0 } }}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <span title="搜索标签页">
        <ActionIcon icon={ChevronDown} size="small" title="搜索标签页" aria-label="搜索标签页" />
      </span>
    </Popover>
  );
}
