/**
 * 标题栏高度（Titlebar 样式与 dock 拖拽 modifier 共用）。
 * 单独抽成常量，避免纯逻辑模块（dockDnd）经 Titlebar 传递性导入桌面运行时，
 * 否则在 jsdom 单测里会初始化窗口桥接。
 */
export const TITLE_BAR_HEIGHT = 38;
