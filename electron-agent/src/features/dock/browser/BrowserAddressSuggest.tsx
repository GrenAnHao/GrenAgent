import { Globe, History, Layers } from 'lucide-react';
import {
  displayBrowserHistoryUrl,
  type AddressSuggestFilter,
  type BrowserHistorySuggestion,
} from './browserHistory';

const FILTERS: Array<{ id: AddressSuggestFilter; label: string; icon: typeof History }> = [
  { id: 'history', label: '历史记录', icon: History },
  { id: 'tabs', label: '标签页', icon: Layers },
];

export function BrowserAddressSuggest({
  open,
  items,
  filter,
  activeIndex,
  onFilter,
  onHover,
  onPick,
  onSwitchTab,
}: {
  open: boolean;
  items: BrowserHistorySuggestion[];
  filter: AddressSuggestFilter;
  activeIndex: number;
  onFilter: (filter: AddressSuggestFilter) => void;
  onHover: (index: number) => void;
  onPick: (item: BrowserHistorySuggestion) => void;
  onSwitchTab: (item: BrowserHistorySuggestion) => void;
}) {
  if (!open) return null;

  return (
    <div id="gren-browser-suggest" className="gren-browser-suggest" role="listbox" aria-label="地址建议">
      <div className="gren-browser-suggest-list">
        {items.length === 0 ? (
          <p className="gren-browser-suggest-empty">{filter === 'tabs' ? '没有其它已打开的标签页' : '暂无访问记录'}</p>
        ) : (
          items.map((item, index) => (
            <div
              key={`${item.kind}:${item.openTabId ?? item.url}`}
              role="option"
              aria-selected={index === activeIndex}
              className={`gren-browser-suggest-item${index === activeIndex ? ' gren-browser-suggest-item-active' : ''}`}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (item.openTabId) onSwitchTab(item);
                else onPick(item);
              }}
            >
              {item.faviconUrl ? (
                <img className="gren-browser-suggest-favicon" src={item.faviconUrl} alt="" />
              ) : (
                <Globe size={16} aria-hidden="true" />
              )}
              <span className="gren-browser-suggest-copy">
                <span className="gren-browser-suggest-title">{item.title}</span>
                <span className="gren-browser-suggest-url">{displayBrowserHistoryUrl(item.url)}</span>
              </span>
              {item.openTabId ? (
                <button
                  type="button"
                  className="gren-browser-suggest-switch"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSwitchTab(item);
                  }}
                >
                  切换到此标签页
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>
      <div className="gren-browser-suggest-footer">
        {FILTERS.map((item) => {
          const Icon = item.icon;
          const active = filter === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`gren-browser-suggest-filter${active ? ' gren-browser-suggest-filter-active' : ''}`}
              aria-pressed={active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onFilter(active ? 'all' : item.id)}
            >
              <Icon size={14} aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
