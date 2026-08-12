// 纯字符串检测，无 DOM 依赖。
const PANEL_SIGNALS = [
  '.mockup', '"split"', '"cards"', 'mockup-body', 'mockup-header',
  'mock-nav', 'mock-sidebar', 'mock-content',
];

export function detectMode(html: string): 'inline' | 'panel' {
  return PANEL_SIGNALS.some((s) => html.includes(s)) ? 'panel' : 'inline';
}
