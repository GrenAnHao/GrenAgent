import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { ChevronDown, ChevronUp, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useThemeStore, type Appearance } from '../../stores/themeStore';
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from '../../theme/contentFont';
import { SettingCard } from './SettingCard';

const APPEARANCES: { value: Appearance; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'auto', label: '跟随系统', icon: Monitor },
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
  control: css`
    display: inline-flex;
    align-items: center;
    gap: 8px;
  `,
  stepper: css`
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 72px;
    height: 36px;
    border-radius: 18px;
    background: ${cssVar.colorFillSecondary};
    font-size: var(--pi-font-size, 14px);
    line-height: calc(24px + var(--pi-font-delta, 0px));

    &:hover [data-arrows],
    &:focus-within [data-arrows] {
      opacity: 1;
    }
  `,
  value: css`
    min-width: 18px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  `,
  unit: css`
    font-size: var(--pi-font-size, 14px);
    color: ${cssVar.colorTextSecondary};
  `,
  arrows: css`
    position: absolute;
    right: 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    opacity: 0;
  `,
  arrow: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 17px;
    height: 12px;
    padding: 0;
    border: none;
    border-radius: 3px;
    color: ${cssVar.colorText};
    background: ${cssVar.colorFillTertiary};
    cursor: pointer;
    &:disabled {
      color: ${cssVar.colorTextQuaternary};
      cursor: default;
    }
  `,
}));

/** 外观设置：对话字号 + 主题（浅/深/跟随系统），直连 themeStore（前端持久化，非后端 config）。 */
export function AppearanceSettings() {
  const appearance = useThemeStore((s) => s.appearance);
  const setAppearance = useThemeStore((s) => s.setAppearance);
  const fontSize = useThemeStore((s) => s.fontSize);
  const setFontSize = useThemeStore((s) => s.setFontSize);

  return (
    <>
      <SettingCard
        title="对话字号"
        desc="只放大可读文字。模块栏、状态标签和代码保持原大小。"
      >
        <div className={styles.control}>
          <div className={styles.stepper} data-testid="font-size-stepper">
            <span className={styles.value}>{fontSize}</span>
            <span className={styles.arrows} data-arrows>
              <button
                type="button"
                className={styles.arrow}
                data-testid="font-size-inc"
                aria-label="增大字号"
                disabled={fontSize >= FONT_SIZE_MAX}
                onClick={() => setFontSize(fontSize + 1)}
              >
                <Icon icon={ChevronUp} size={9} />
              </button>
              <button
                type="button"
                className={styles.arrow}
                data-testid="font-size-dec"
                aria-label="减小字号"
                disabled={fontSize <= FONT_SIZE_MIN}
                onClick={() => setFontSize(fontSize - 1)}
              >
                <Icon icon={ChevronDown} size={9} />
              </button>
            </span>
          </div>
          <span className={styles.unit}>px</span>
        </div>
      </SettingCard>
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
    </>
  );
}
