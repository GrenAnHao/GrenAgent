import {
  ColorSwatches,
  Icon,
  findCustomThemeName,
  neutralColors,
  neutralColorsSwatches,
  primaryColors,
  primaryColorsSwatches,
} from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useThemeStore, type Appearance, type NeutralColor, type PrimaryColor } from '../../stores/themeStore';
import { COLOR_SCHEMES } from '../../theme/colorSchemes';
import { SettingCard } from './SettingCard';

const APPEARANCES: { value: Appearance; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'auto', label: '跟随系统', icon: Monitor },
];

// 色板取自 @lobehub/ui 的预设色源（不硬编码 hex）；选中的“名字”对应 ThemeProvider customTheme。
// 第一项透明色 = 未选（ColorSwatches 约定：透明项 + 未选值 = 清除自定义色），点它即回落到默认来源：
// 主题色回落到配色方案自带的主色，中性色回落到库默认。
const primarySwatches = [
  { color: 'rgba(0, 0, 0, 0)', title: '跟随方案' },
  ...primaryColorsSwatches.map((color) => ({ color })),
];
const neutralSwatches = [
  { color: 'rgba(0, 0, 0, 0)', title: '默认' },
  ...neutralColorsSwatches.map((color) => ({ color })),
];

const styles = createStaticStyles(({ css }) => ({
  themeRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  `,
  themeCard: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: 96px;
    padding: 14px 10px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;
    transition:
      border-color 0.15s,
      color 0.15s;

    &:hover {
      color: ${cssVar.colorText};
      border-color: ${cssVar.colorBorderSecondary};
    }
  `,
  themeCardActive: css`
    border-color: ${cssVar.colorPrimary};
    color: ${cssVar.colorText};
  `,
  themeLabel: css`
    font-size: 12px;
  `,
  swatch: css`
    display: flex;
    width: 44px;
    height: 22px;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 6px;
  `,
}));

/** 外观设置：主题（浅/深/跟随系统）+ 主题色 + 中性色，直连 themeStore（前端持久化，非后端 config）。 */
export function AppearanceSettings() {
  const appearance = useThemeStore((s) => s.appearance);
  const setAppearance = useThemeStore((s) => s.setAppearance);
  const primaryColor = useThemeStore((s) => s.primaryColor);
  const setPrimaryColor = useThemeStore((s) => s.setPrimaryColor);
  const neutralColor = useThemeStore((s) => s.neutralColor);
  const setNeutralColor = useThemeStore((s) => s.setNeutralColor);
  const colorScheme = useThemeStore((s) => s.colorScheme);
  const setColorScheme = useThemeStore((s) => s.setColorScheme);

  return (
    <>
      <SettingCard title="主题">
        <div className={styles.themeRow}>
          {APPEARANCES.map((a) => (
            <button
              key={a.value}
              type="button"
              data-testid={`appearance-${a.value}`}
              className={cx(styles.themeCard, appearance === a.value && styles.themeCardActive)}
              onClick={() => setAppearance(a.value)}
            >
              <Icon icon={a.icon} size={20} />
              <span className={styles.themeLabel}>{a.label}</span>
            </button>
          ))}
        </div>
      </SettingCard>
      <SettingCard title="配色方案">
        <div className={styles.themeRow}>
          {COLOR_SCHEMES.map((scheme) => (
            <button
              key={scheme.id}
              type="button"
              data-testid={`scheme-${scheme.id}`}
              className={cx(styles.themeCard, colorScheme === scheme.id && styles.themeCardActive)}
              onClick={() => setColorScheme(scheme.id)}
            >
              <span className={styles.swatch}>
                <span style={{ flex: 1, background: scheme.preview[0] }} />
                <span style={{ flex: 1, background: scheme.preview[1] }} />
                <span style={{ flex: 1, background: scheme.preview[2] }} />
              </span>
              <span className={styles.themeLabel}>{scheme.label}</span>
            </button>
          ))}
        </div>
      </SettingCard>
      <SettingCard title="主题色">
        <ColorSwatches
          enableColorPicker={false}
          colors={primarySwatches}
          value={primaryColor ? primaryColors[primaryColor] : undefined}
          onChange={(color) =>
            setPrimaryColor(color ? (findCustomThemeName('primary', color) as PrimaryColor | undefined) : undefined)
          }
        />
      </SettingCard>
      <SettingCard title="中性色">
        <ColorSwatches
          enableColorPicker={false}
          colors={neutralSwatches}
          value={neutralColor ? neutralColors[neutralColor] : undefined}
          onChange={(color) =>
            setNeutralColor(color ? (findCustomThemeName('neutral', color) as NeutralColor | undefined) : undefined)
          }
        />
      </SettingCard>
    </>
  );
}
