import { useLayoutEffect } from 'react';
import { useTheme } from 'antd-style';
import { getCurrentWindow } from '../platform/runtime';
import { useFontSizeSync } from '../theme/useFontSizeSync';

/**
 * antd cssVar 变量表的 key。cssinjs 把整份 --ant-* 序列化成 `.<key>{...}` 这一条类规则，
 * 而 antd 只把 `ant-<组件>-css-var` 加在各组件根节点上，从不把这个 key 加到任何元素——
 * 于是靠继承取 --ant-* 的消费者（@lobehub/ui 组件、createStaticStyles + cssVar.* 的静态样式，
 * 以及本文件派生的 --gren-*）全都拿不到值，在深色下退回浅色兜底。下方把它挂到根元素修正。
 * 与 App 的 ConfigProvider theme.cssVar.key 必须一致。
 */
export const ANTD_CSS_VAR_KEY = 'gren-css-var';

/**
 * 把 lobe-ui 当前主题 token 同步到 body 背景与 --gren-* 占位变量，使所有管理面板
 * 配色随主题/方案/明暗统一变化（面板代码无需改）。用 useLayoutEffect 在绘制前写入，
 * 与 antd cssVar 同一帧切换，避免「内容已变、底色慢一拍」的中间异色。自身不渲染 DOM。
 */
export function ThemeBridge() {
  const theme = useTheme();
  useFontSizeSync();

  useLayoutEffect(() => {
    // 让 --ant-* 在根元素上就有定义，全树（含非 antd 元素）都能继承到当前明暗的真实值。
    document.documentElement.classList.add(ANTD_CSS_VAR_KEY);
    document.documentElement.dataset.theme = theme.appearance;
    // 原生窗口底色对齐当前明暗下的首屏底色（index.html 按 data-theme 切换的 --boot-bg），主进程记下给下次
    // 启动的窗口用：窗口出现到首帧画出之间（约 0.5s）露出的是它，不对齐的话浅色主题启动会先闪一下深色。
    const bootBg = getComputedStyle(document.documentElement).getPropertyValue('--boot-bg').trim();
    // window.gren 由 preload 暴露：dev 下渲染层热更新、preload 需重启 Electron 进程才重建，两者会版本错配——
    // 老 preload 没有 setBackgroundColor。缺了就跳过（重启后自然生效），不要让 layout effect 抛错拖垮整棵树。
    const win = getCurrentWindow();
    if (bootBg && typeof win.setBackgroundColor === 'function') {
      win.setBackgroundColor(bootBg).catch((error: unknown) => console.warn('[GrenAgent] 同步窗口底色失败：', error));
    }
    // html 与 body 都要接管：index.html 为首屏骨架把 `html, body` 写死成 #0b0d12，只改 body
    // 的话 <html> 在亮色主题下仍是深色底，会在 body 未覆盖处（首帧、窗口 resize、overscroll）
    // 露出深色。
    document.documentElement.style.backgroundColor = theme.colorBgLayout;
    document.body.style.backgroundColor = theme.colorBgLayout;

    const root = document.documentElement.style;
    root.setProperty('--gren-fg', theme.colorText);
    root.setProperty('--gren-fg-muted', theme.colorTextSecondary);
    root.setProperty('--gren-border', theme.colorBorderSecondary);
    root.setProperty('--gren-rail-active', theme.colorFillTertiary);
    root.setProperty('--gren-bg-1', theme.colorBgContainer);
    root.setProperty('--gren-bg-2', theme.colorFillSecondary);
    root.setProperty('--gren-bg-3', theme.colorFillTertiary);
    root.setProperty('--gren-acc', theme.colorPrimary);
    // 表面填充与淡强调底：ConnectionsPanel 的气泡、MainColumnHeader 的 plan-mode 徽章消费它们。
    // 此前从未定义，两处永远走硬编码 fallback（半透明白 / 紫蓝），不随主题变化。
    root.setProperty('--gren-surface', theme.colorFillSecondary);
    // 主色淡底用 color-mix 现算半透明，不用 colorPrimaryBg：后者是不透明实色，暗色下取到
    // #111111，叠在 #0d1117 的顶栏上几乎看不见（lobe 的主色是近白中性色，其 Bg 会很暗）。
    root.setProperty('--gren-accent-soft', `color-mix(in srgb, ${theme.colorPrimary} 22%, transparent)`);
    // 三区分层背景全部取自主题 token：侧栏+标题栏用更深的布局底色，内容区用容器色。
    root.setProperty('--gren-titlebar-bg', theme.colorBgLayout);
    root.setProperty('--gren-sidebar-bg', theme.colorBgLayout);
    root.setProperty('--gren-content-bg', theme.colorBgContainer);
    // 依赖整个 theme 对象：effect 读了十余个 token，逐个列举漏一个就会出现「换配色方案后
    // 某个 --gren-* 不更新」。antd-style 每次渲染重建 theme 对象，而 ThemeBridge 无自身
    // state，只在主题上下文变化时重渲染，因此这里等价于「主题变了就重写」，开销可忽略。
  }, [theme]);

  return null;
}
