import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createStaticStyles, cssVar } from 'antd-style';
import { useLayoutStore, type SidebarDrawerMode } from '../../stores/layoutStore';
import { useModuleStore } from '../../stores/moduleStore';

export const SIDEBAR_DRAWER_MOTION_MS = 180;

const styles = createStaticStyles(({ css }) => ({
  // 裁切框钉在内容区左缘（模块栏右侧）。面板在框内平移，滑出时不会扫过图标栏，也不会从窗口左缘进来。
  frame: css`
    position: fixed;
    z-index: 30;
    overflow: hidden;
    outline: none;
  `,
  sheet: css`
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;

    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};
    background: var(--gren-sidebar-bg, ${cssVar.colorBgLayout});

    transform: translateX(-100%);
    transition: transform ${SIDEBAR_DRAWER_MOTION_MS}ms ease;

    &[data-entered='true'] {
      transform: translateX(0);
    }
  `,
}));

interface DrawerRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function readRowRect(): DrawerRect | null {
  const row = document.querySelector('[data-sidebar-row]');
  if (!row) return null;
  const rect = row.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function isDrawerAffordance(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      '[data-sidebar-drawer], [data-testid="sidebar-toggle"], .ant-dropdown, .ant-popover, .ant-modal, .ant-select-dropdown',
    ),
  );
}

/**
 * 抽屉要等滑出动画结束再卸掉。open 变 false 时先把 entered 拉回，面板滑回内容区左缘，再 present=false。
 */
export function useSidebarDrawerPresence(open: boolean, mode: SidebarDrawerMode | null) {
  const [present, setPresent] = useState(open);
  const [entered, setEntered] = useState(false);
  const modeRef = useRef<SidebarDrawerMode | null>(mode);
  const presentRef = useRef(open);
  if (mode) modeRef.current = mode;

  useLayoutEffect(() => {
    if (open) {
      presentRef.current = true;
      setPresent(true);
      const id = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(id);
    }
    setEntered(false);
    if (!presentRef.current) return;
    const timer = window.setTimeout(() => {
      presentRef.current = false;
      setPresent(false);
    }, SIDEBAR_DRAWER_MOTION_MS + 32);
    return () => clearTimeout(timer);
  }, [open]);

  return { present, entered, mode: mode ?? modeRef.current };
}

/**
 * 会话列表覆盖层。停靠列收起时把同一份侧栏内容滑到内容区左侧，不挤压对话宽度。
 * 在里面点会话继续留着；指针离开这块布局，或点到布局外面，才收回。
 */
export function SidebarDrawer({
  mode,
  entered = true,
  children,
}: {
  mode: SidebarDrawerMode;
  entered?: boolean;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DrawerRect | null>(() => readRowRect());
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const closeSidebarDrawer = useLayoutStore((s) => s.closeSidebarDrawer);
  const scheduleSidebarHoverClose = useLayoutStore((s) => s.scheduleSidebarHoverClose);
  const cancelSidebarHoverClose = useLayoutStore((s) => s.cancelSidebarHoverClose);
  const activeModule = useModuleStore((s) => s.activeModule);

  useLayoutEffect(() => {
    const update = () => setRect(readRowRect());
    update();
    const row = document.querySelector('[data-sidebar-row]');
    const observer = row ? new ResizeObserver(update) : null;
    if (row) observer?.observe(row);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    if (mode !== 'toggle') return;
    const panel = panelRef.current;
    if (!panel || panel.contains(document.activeElement)) return;
    panel.focus({ preventScroll: true });
  }, [mode]);

  useEffect(() => {
    if (activeModule !== 'chat') closeSidebarDrawer();
  }, [activeModule, closeSidebarDrawer]);

  useEffect(() => {
    if (mode !== 'toggle') return;
    const onPointerDown = (event: PointerEvent) => {
      if (isDrawerAffordance(event.target)) return;
      closeSidebarDrawer();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSidebarDrawer();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [mode, closeSidebarDrawer]);

  if (!rect) return null;

  const width = Math.max(160, Math.min(sidebarWidth, rect.width - 48));

  return createPortal(
    <div
      ref={panelRef}
      className={styles.frame}
      data-testid="sidebar-drawer"
      data-sidebar-drawer=""
      data-mode={mode}
      role="dialog"
      aria-label="会话列表"
      tabIndex={-1}
      style={{
        top: rect.top,
        left: rect.left,
        height: rect.height,
        width,
        pointerEvents: entered ? 'auto' : 'none',
      }}
      onPointerEnter={() => cancelSidebarHoverClose()}
      onPointerLeave={(event) => {
        const next = event.relatedTarget;
        if (
          next instanceof Element &&
          next.closest(
            '[data-testid="module-chat"], [data-testid="sidebar-toggle"], [data-sidebar-drawer], .ant-dropdown, .ant-popover, .ant-modal, .ant-select-dropdown',
          )
        ) {
          return;
        }
        scheduleSidebarHoverClose();
      }}
    >
      <div className={styles.sheet} data-entered={entered ? 'true' : 'false'}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
