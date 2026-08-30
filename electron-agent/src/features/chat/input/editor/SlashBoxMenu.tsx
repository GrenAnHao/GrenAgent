import { isValidElement, memo, useEffect, useMemo, useRef, useState, type FC, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon, LOBE_THEME_APP_ID } from '@lobehub/ui';
import type { LucideIcon } from 'lucide-react';
import type { ISlashMenuOption, ISlashOption } from '@lobehub/editor';
import { createStaticStyles, cssVar, cx } from 'antd-style';

/** 与 @lobehub/editor 的 slash/mention renderComp 约定一致。 */
interface MenuRenderProps {
  activeKey: string | null;
  loading?: boolean;
  onSelect?: (option: ISlashMenuOption) => void;
  open?: boolean;
  options: Array<ISlashOption>;
  setActiveKey: (key: string | null) => void;
}

const MENU_GAP = 8;

const styles = createStaticStyles(({ css }) => ({
  root: css`
    position: fixed;
    z-index: 1100;
    box-sizing: border-box;

    overflow: hidden;

    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};
  `,
  scroll: css`
    scrollbar-width: thin;

    overflow-y: auto;

    max-height: min(46vh, 360px);
    padding: 4px;
  `,
  item: css`
    display: flex;
    gap: 8px;
    align-items: center;

    padding: 6px 8px;
    border-radius: ${cssVar.borderRadius};

    color: ${cssVar.colorText};

    cursor: pointer;
  `,
  active: css`
    background: ${cssVar.colorFillSecondary};
  `,
  label: css`
    flex-shrink: 0;

    font-size: 13px;
  `,
  extra: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;

    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  divider: css`
    height: 1px;
    margin: 4px 6px;

    background: ${cssVar.colorBorderSecondary};
  `,
  header: css`
    padding: 6px 8px 2px;

    font-size: 11px;
    font-weight: 600;
    color: ${cssVar.colorTextTertiary};
  `,
  state: css`
    padding: 8px 10px;

    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

function isDivider(o: ISlashOption): o is { type: 'divider'; label?: string } {
  return 'type' in o && o.type === 'divider';
}

function renderMenuIcon(icon: ISlashMenuOption['icon']) {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  return <Icon icon={icon as LucideIcon} size={15} />;
}

/**
 * 菜单锚定在输入框（anchor）正上方，宽度与输入框齐宽——不跟随光标，避免输入时乱跳。
 * 键盘导航交给编辑器（activeKey/Enter/方向键），这里负责渲染、悬停高亮、点击选中。
 */
export function createBoxMenu(anchorRef: RefObject<HTMLElement | null>): FC<MenuRenderProps> {
  const BoxMenu: FC<MenuRenderProps> = memo(
    ({ open, loading, options, activeKey, onSelect, setActiveKey }) => {
      const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
      const listRef = useRef<HTMLDivElement>(null);

      const portalContainer = useMemo(
        () => document.getElementById(LOBE_THEME_APP_ID) ?? document.body,
        [],
      );

      useEffect(() => {
        if (!open) return;
        const anchor = anchorRef.current;
        if (!anchor) return;
        const measure = () => {
          const rect = anchor.getBoundingClientRect();
          if (rect.width === 0) return;
          setPos({
            left: Math.round(rect.left),
            bottom: Math.round(window.innerHeight - rect.top + MENU_GAP),
            width: Math.round(rect.width),
          });
        };
        measure();
        const onChange = () => requestAnimationFrame(measure);
        const ro = new ResizeObserver(onChange);
        ro.observe(anchor);
        window.addEventListener('resize', onChange);
        window.addEventListener('scroll', onChange, true);
        return () => {
          ro.disconnect();
          window.removeEventListener('resize', onChange);
          window.removeEventListener('scroll', onChange, true);
        };
      }, [open]);

      useEffect(() => {
        if (!open || !activeKey) return;
        listRef.current?.querySelector(`[data-key="${CSS.escape(activeKey)}"]`)?.scrollIntoView({
          block: 'nearest',
        });
      }, [activeKey, open]);

      // 首行是分组标题（divider 无 key），编辑器不会自动高亮首项；这里兜底高亮第一个可选项，
      // 并在过滤后旧 activeKey 失效时复位，避免高亮悬空、Enter 落空。
      useEffect(() => {
        if (!open) return;
        const selectable = options.filter((o): o is ISlashMenuOption => !isDivider(o));
        if (selectable.length === 0) return;
        const valid = activeKey != null && selectable.some((o) => String(o.key) === activeKey);
        if (!valid) setActiveKey(String(selectable[0].key));
      }, [open, options, activeKey, setActiveKey]);

      if (!open || !pos) return null;

      const hasItems = options.some((o) => !isDivider(o));

      return createPortal(
        <div
          className={styles.root}
          style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className={styles.scroll} ref={listRef}>
            {!hasItems ? (
              <div className={styles.state}>{loading ? '加载中…' : '无匹配项'}</div>
            ) : (
              options.map((opt, index) => {
                if (isDivider(opt))
                  return opt.label ? (
                    <div key={`header-${index}`} className={styles.header}>
                      {opt.label}
                    </div>
                  ) : (
                    <div key={`divider-${index}`} className={styles.divider} />
                  );
                const item = opt as ISlashMenuOption;
                const key = String(item.key);
                return (
                  <div
                    key={key}
                    data-key={key}
                    className={cx(styles.item, key === activeKey && styles.active)}
                    onMouseEnter={() => setActiveKey(key)}
                    onClick={() => onSelect?.(item)}
                  >
                    {renderMenuIcon(item.icon)}
                    <span className={styles.label}>{item.label}</span>
                    {item.extra ? <span className={styles.extra}>{item.extra}</span> : null}
                  </div>
                );
              })
            )}
          </div>
        </div>,
        portalContainer,
      );
    },
  );
  BoxMenu.displayName = 'BoxMenu';
  return BoxMenu;
}
