import { useEffect, useRef } from 'react';
import { useTheme } from 'antd-style';

/**
 * 把 lobe-ui 当前主题的 colorBgLayout 同步到 body 背景,
 * 避免窗口边缘/滚动回弹露出浏览器默认白底 (亮/暗切换时尤其明显)。
 * 直接读 antd 实际 token, 因此与 lobe 默认主题完全一致, 自身不渲染任何 DOM。
 */
export function ThemeBridge() {
  const theme = useTheme();
  const previousAppearanceRef = useRef(theme.appearance);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const isDark = theme.appearance === 'dark';
    document.documentElement.dataset.theme = theme.appearance;
    document.body.style.backgroundColor = isDark ? '#0d0d0d' : '#ffffff';

    // 把管理面板用到的 --gren-* 占位变量接到当前主题 token，
    // 使知识库/记忆/审查/创作/设置/连接面板的配色随亮/暗切换（面板代码无需改）。
    const root = document.documentElement.style;
    root.setProperty('--gren-fg', theme.colorText);
    root.setProperty('--gren-fg-muted', theme.colorTextSecondary);
    root.setProperty('--gren-border', theme.colorBorderSecondary);
    root.setProperty('--gren-rail-active', theme.colorFillTertiary);
    root.setProperty('--gren-bg-1', theme.colorBgContainer);
    root.setProperty('--gren-bg-2', theme.colorFillSecondary);
    root.setProperty('--gren-bg-3', theme.colorFillTertiary);
    root.setProperty('--gren-acc', theme.colorPrimary);
    // 三区分层背景（用户指定 hex；侧栏最深 < 顶部条 < 内容区，亮/暗各一套）
    root.setProperty('--gren-titlebar-bg', isDark ? '#090909' : '#f8f8f8');
    root.setProperty('--gren-sidebar-bg', isDark ? '#000000' : '#f8f8f8');
    root.setProperty('--gren-content-bg', isDark ? '#0d0d0d' : '#ffffff');

    if (previousAppearanceRef.current !== theme.appearance) {
      document.documentElement.classList.add('theme-transitioning');
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => {
        document.documentElement.classList.remove('theme-transitioning');
        timeoutRef.current = null;
      }, 220);
      previousAppearanceRef.current = theme.appearance;
    }

    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      document.documentElement.classList.remove('theme-transitioning');
    };
  }, [theme.appearance, theme.colorBgLayout]);

  return null;
}
