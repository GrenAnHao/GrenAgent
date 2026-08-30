// 主流暗/亮色配色预设。每个方案给一组 antd token 覆盖（表面/文字/边框），
// 经 App 的 ThemeProvider theme.token 注入；ThemeBridge 再把 --gren-* 派生出去，全局一致。
// 取值参考各方案官方调色板（GitHub Dark / One Dark / Dracula / Nord / Tokyo Night /
// Catppuccin / Linear / Solarized），非纯黑、按亮度分层、正文高对比。

/** 主题色预设名（= @lobehub/ui colorScales 的键，也是 customTheme.primaryColor 的取值）。 */
export type PrimaryColorName =
  | 'blue'
  | 'cyan'
  | 'geekblue'
  | 'gold'
  | 'green'
  | 'lime'
  | 'magenta'
  | 'orange'
  | 'purple'
  | 'red'
  | 'volcano'
  | 'yellow';

// 注意：这里不能放 colorPrimary。@lobehub/ui 的 darkAlgorithm/lightAlgorithm 会在 antd 基础
// 算法的产物之后无条件展开 darkBaseToken/lightBaseToken，而这两份 base token 把整套 primary
// 家族硬编码成灰阶（dark colorPrimary=#eeeeee / light #222222）。因此 theme.token.colorPrimary
// 永远被覆盖掉，唯一生效的入口是 seedToken.primaryColor（预设名）→ 见下面的 primary 字段。
export interface SchemeTokens {
  colorBgLayout: string;
  colorBgContainer: string;
  colorBgElevated: string;
  colorBorder: string;
  colorBorderSecondary: string;
  colorText: string;
  colorTextSecondary: string;
  colorTextTertiary: string;
}

export interface ColorScheme {
  id: string;
  label: string;
  /** 选择器预览用：[底色, 表面色, 主色]。 */
  preview: [string, string, string];
  /**
   * 主题色预设名，按明暗分开取：lobe 的色阶在 index 9（= colorPrimary）上并不总是随明暗变化，
   * 例如 blue 亮暗两档都是浅蓝（亮色底下对比仅 ~2:1，做链接/文字不可用），而 geekblue 两档
   * 都是 #0072f5（亮色底合适、暗色底偏暗）。所以按外观各选最贴近该方案官方强调色的一档。
   */
  primary?: { dark: PrimaryColorName; light: PrimaryColorName };
  dark?: SchemeTokens;
  light?: SchemeTokens;
}

export const DEFAULT_COLOR_SCHEME = 'github';

export const COLOR_SCHEMES: ColorScheme[] = [
  {
    id: 'default',
    label: '库默认',
    preview: ['#1f1f1f', '#2a2a2a', '#1677ff'],
  },
  {
    id: 'github',
    label: 'GitHub',
    preview: ['#0d1117', '#161b22', '#58a6ff'],
    primary: { dark: 'blue', light: 'geekblue' },
    dark: {
      colorBgLayout: '#0d1117',
      colorBgContainer: '#161b22',
      colorBgElevated: '#1c2128',
      colorBorder: '#30363d',
      colorBorderSecondary: '#21262d',
      colorText: '#e6edf3',
      colorTextSecondary: '#8b949e',
      colorTextTertiary: '#6e7681',
    },
    light: {
      colorBgLayout: '#f6f8fa',
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorBorder: '#d1d9e0',
      colorBorderSecondary: '#d1d9e0',
      colorText: '#1f2328',
      colorTextSecondary: '#59636e',
      colorTextTertiary: '#818b98',
    },
  },
  {
    id: 'onedark',
    label: 'One Dark',
    preview: ['#21252b', '#282c34', '#61afef'],
    primary: { dark: 'blue', light: 'geekblue' },
    dark: {
      colorBgLayout: '#21252b',
      colorBgContainer: '#282c34',
      colorBgElevated: '#2f343d',
      colorBorder: '#3e4451',
      colorBorderSecondary: '#21252b',
      colorText: '#abb2bf',
      colorTextSecondary: '#828997',
      colorTextTertiary: '#5c6370',
    },
    light: {
      colorBgLayout: '#fafafa',
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorBorder: '#dbdbdc',
      colorBorderSecondary: '#e5e5e6',
      colorText: '#383a42',
      colorTextSecondary: '#696c77',
      colorTextTertiary: '#a0a1a7',
    },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    preview: ['#21222c', '#282a36', '#bd93f9'],
    // 官方强调色是紫罗兰；数值上 blue 更近，但会丢掉方案辨识度，取 purple。
    primary: { dark: 'purple', light: 'purple' },
    dark: {
      colorBgLayout: '#21222c',
      colorBgContainer: '#282a36',
      colorBgElevated: '#343746',
      colorBorder: '#44475a',
      colorBorderSecondary: '#343746',
      colorText: '#f8f8f2',
      colorTextSecondary: '#c5c8d6',
      colorTextTertiary: '#6272a4',
    },
    light: {
      colorBgLayout: '#f8f8f2',
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorBorder: '#d5d8e0',
      colorBorderSecondary: '#e3e5ee',
      colorText: '#1f1f1f',
      colorTextSecondary: '#57555c',
      colorTextTertiary: '#8c8ca0',
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    preview: ['#2e3440', '#3b4252', '#88c0d0'],
    // Nord 的 #88c0d0 是偏蓝的极地青；lobe 的 cyan 是薄荷绿，偏得更远，故用 blue。
    primary: { dark: 'blue', light: 'geekblue' },
    dark: {
      colorBgLayout: '#2e3440',
      colorBgContainer: '#3b4252',
      colorBgElevated: '#434c5e',
      colorBorder: '#4c566a',
      colorBorderSecondary: '#3b4252',
      colorText: '#eceff4',
      colorTextSecondary: '#d8dee9',
      colorTextTertiary: '#7b88a1',
    },
    light: {
      colorBgLayout: '#eceff4',
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorBorder: '#d8dee9',
      colorBorderSecondary: '#e5e9f0',
      colorText: '#2e3440',
      colorTextSecondary: '#4c566a',
      colorTextTertiary: '#7b88a1',
    },
  },
  {
    id: 'tokyo',
    label: 'Tokyo Night',
    preview: ['#16161e', '#1a1b26', '#7aa2f7'],
    primary: { dark: 'blue', light: 'geekblue' },
    dark: {
      colorBgLayout: '#16161e',
      colorBgContainer: '#1a1b26',
      colorBgElevated: '#24283b',
      colorBorder: '#3b4261',
      colorBorderSecondary: '#24283b',
      colorText: '#c0caf5',
      colorTextSecondary: '#a9b1d6',
      colorTextTertiary: '#565f89',
    },
    light: {
      colorBgLayout: '#e1e2e7',
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorBorder: '#c4c8da',
      colorBorderSecondary: '#d6d8e0',
      colorText: '#343b58',
      colorTextSecondary: '#6172b0',
      colorTextTertiary: '#848cb5',
    },
  },
  {
    id: 'catppuccin',
    label: 'Catppuccin',
    preview: ['#181825', '#1e1e2e', '#cba6f7'],
    primary: { dark: 'purple', light: 'purple' },
    dark: {
      colorBgLayout: '#181825',
      colorBgContainer: '#1e1e2e',
      colorBgElevated: '#313244',
      colorBorder: '#45475a',
      colorBorderSecondary: '#313244',
      colorText: '#cdd6f4',
      colorTextSecondary: '#a6adc8',
      colorTextTertiary: '#6c7086',
    },
    light: {
      colorBgLayout: '#e6e9ef',
      colorBgContainer: '#eff1f5',
      colorBgElevated: '#ffffff',
      colorBorder: '#ccd0da',
      colorBorderSecondary: '#dce0e8',
      colorText: '#4c4f69',
      colorTextSecondary: '#6c6f85',
      colorTextTertiary: '#9ca0b0',
    },
  },
  {
    id: 'linear',
    label: 'Linear',
    preview: ['#08090a', '#101113', '#5e6ad2'],
    // Linear 的靛蓝 #5e6ad2 亮暗同色，geekblue 两档也同色且最贴近。
    primary: { dark: 'geekblue', light: 'geekblue' },
    dark: {
      colorBgLayout: '#08090a',
      colorBgContainer: '#101113',
      colorBgElevated: '#18191b',
      colorBorder: '#23252a',
      colorBorderSecondary: '#1a1b1d',
      colorText: '#f7f8f8',
      colorTextSecondary: '#b4b8c0',
      colorTextTertiary: '#6f7178',
    },
    light: {
      colorBgLayout: '#f9f9fb',
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorBorder: '#e6e6ea',
      colorBorderSecondary: '#ededf0',
      colorText: '#16171a',
      colorTextSecondary: '#61656c',
      colorTextTertiary: '#8a8f98',
    },
  },
  {
    // Solarized（Ethan Schoonover 经典配色）：最主流的浅色主打方案——独特的米黄护眼底，
    // 官方 light + dark 两套都正宗。preview 用浅色，在选择器里一眼区别于上面的深色主打方案。
    // 取值为官方十六色板（base2 #eee8d5 / base3 #fdf6e3 单色 + blue #268bd2 强调）。
    id: 'solarized',
    label: 'Solarized',
    preview: ['#eee8d5', '#fdf6e3', '#268bd2'],
    // 官方强调色 #268bd2 亮暗同色。亮色用 geekblue（#0072f5，米黄底上 3.6:1）最贴近；
    // 暗色不能也用 geekblue —— Solarized 的「深色」底其实是偏亮的深青（#002b36/#073642），
    // 饱和深蓝压上去实测只有 2.93:1，故暗色改用 blue（#60b1ff，约 6:1）。
    primary: { dark: 'blue', light: 'geekblue' },
    light: {
      colorBgLayout: '#eee8d5',
      colorBgContainer: '#fdf6e3',
      colorBgElevated: '#fffdf3',
      colorBorder: '#d9d2bb',
      colorBorderSecondary: '#e7e0c9',
      colorText: '#586e75',
      colorTextSecondary: '#657b83',
      colorTextTertiary: '#93a1a1',
    },
    dark: {
      colorBgLayout: '#002b36',
      colorBgContainer: '#073642',
      colorBgElevated: '#0a4250',
      colorBorder: '#2a4a55',
      colorBorderSecondary: '#0d3e4a',
      colorText: '#93a1a1',
      colorTextSecondary: '#839496',
      colorTextTertiary: '#657b83',
    },
  },
];

const SCHEME_MAP = new Map(COLOR_SCHEMES.map((s) => [s.id, s]));

const hexToRgb = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (rgb: number[]): string => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** WCAG 相对亮度。 */
function relLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const mixHex = (a: string, b: string, w: number): string =>
  toHex(hexToRgb(a).map((v, i) => v * (1 - w) + hexToRgb(b)[i] * w));

/**
 * 把 muted 档朝正文色提亮，直到在参考底色上达到 WCAG 1.4.11 要求的 3:1（UI 组件与有意义图形）。
 *
 * 这些方案的「注释色」是为代码调的、刻意后退；直接拿来做 UI 的图标 / 占位 / 元数据就会糊进背景
 * （实测 dracula 暗色 2.51:1、catppuccin 亮色 2.30:1、solarized 亮色 2.48:1）。朝方案自己的
 * colorText 混、而不是朝纯白纯黑混，色相和方案气质都保住；本来就达标的方案（github 3.8:1、
 * linear 3.9:1）原样返回，不动一个像素。
 */
function liftToMinContrast(fg: string, surfaces: string[], text: string, min = 3): string {
  // 取最坏表面：对偏暗的 muted 前景来说「更亮的底 = 更高对比」，所以暗色方案的最坏情况是最亮的表面
  // （elevated），亮色方案反而是最暗的那个（layout）。这里直接挑对比最低的一个，不按明暗硬猜。
  // 提亮方向固定朝 colorText，过程中最坏表面不会易主，因此只需判定一次。
  const bg = surfaces.reduce((a, b) => (contrastRatio(fg, a) <= contrastRatio(fg, b) ? a : b));
  if (contrastRatio(fg, bg) >= min) return fg;
  for (let w = 0.05; w < 1; w += 0.05) {
    const c = mixHex(fg, text, w);
    if (contrastRatio(c, bg) >= min) return c;
  }
  return text;
}

/**
 * 取某方案在指定明暗下的 token 覆盖；'default' 或未知 id 返回 undefined（用库默认）。
 *
 * 第三、四档文字色是派生的，不手写：
 *  - lobe 的 base token 把 colorTextQuaternary 写成与方案无关的中性灰（暗 #555555 / 亮 #bbbbbb），
 *    而本项目把这一档用在元数据文字、展开箭头、状态点等需要看清的地方（20+ 处），暗色下压在容器底上
 *    只有 2.3:1 —— 正是「图标和背景糊成一片」的来源。各方案官方板最暗只到「注释色」这一档，
 *    所以第四档取第三档：跟着方案走，且任何方案下都不比库默认更差。
 *  - 再对这一档兜 3:1 的对比度下限（见 liftToMinContrast），参考底色取该方案 layout / container /
 *    elevated 三层表面里最坏的那一个，兜住最坏则三层都够。
 *
 * 两处代价，都是有意选的：
 *  - antd 的 colorTextPlaceholder / colorTextDisabled 都别名到第四档，会跟着变亮一点。
 *  - 本身就是低对比设计的方案（Solarized 最典型，One Dark 次之），正文色自己在底上也只有 4:1 上下，
 *    muted 抬到 3:1 后就贴近正文了（实测 Solarized 两套的 muted↔正文只剩 1.35~1.45:1），
 *    正文与次要文字的层次会变弱。这类方案的调色板里根本腾不出「既 ≥3:1 又明显弱于正文」的空间，
 *    只能二选一；这里优先保证看得见（WCAG 1.4.11 对 UI 组件与有意义图形要求 3:1），
 *    因为糊进背景的图标是实打实的可用性问题，层次弱一点只是观感差异。
 */
export function schemeTokens(
  id: string | undefined,
  isDark: boolean,
): (SchemeTokens & { colorTextQuaternary: string }) | undefined {
  const scheme = id ? SCHEME_MAP.get(id) : undefined;
  const t = scheme ? (isDark ? scheme.dark : scheme.light) : undefined;
  if (!t) return undefined;
  const muted = liftToMinContrast(
    t.colorTextTertiary,
    [t.colorBgLayout, t.colorBgContainer, t.colorBgElevated],
    t.colorText,
  );
  return { ...t, colorTextTertiary: muted, colorTextQuaternary: muted };
}

/** 取某方案在指定明暗下的主题色预设名；无则 undefined（用库默认灰）。 */
export function schemePrimary(id: string | undefined, isDark: boolean): PrimaryColorName | undefined {
  const scheme = id ? SCHEME_MAP.get(id) : undefined;
  if (!scheme?.primary) return undefined;
  return isDark ? scheme.primary.dark : scheme.primary.light;
}
