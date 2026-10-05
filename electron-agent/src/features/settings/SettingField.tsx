import { Flexbox } from '@lobehub/ui';
import { Input, InputNumber, Select, Slider, Switch } from 'antd';
import { createStyles } from 'antd-style';
import { useState } from 'react';
import type { SettingField } from './settingsSchema';
import { ModelListField } from './ModelListField';
import { ModelSelectField } from './ModelSelectField';

const useStyles = createStyles(({ css, token }) => ({
  row: css`
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding-block: 10px;
  `,
  meta: css`
    flex: 1 1 auto;
    min-width: 0;
  `,
  label: css`
    font-size: var(--pi-font-size, 14px);
    color: ${token.colorText};
  `,
  desc: css`
    margin-block-start: 2px;
    font-size: var(--pi-font-size-secondary, 13px);
    color: ${token.colorTextDescription};
  `,
  control: css`
    flex: 0 0 auto;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    min-height: calc(22px + var(--pi-font-delta, 0px));
  `,
  wide: css`
    flex: 1 1 auto;
    min-width: 0;
  `,
}));

interface Props {
  field: SettingField;
  value: string;
  onChange: (v: string) => void;
  /** testid 前缀，默认 set-field；连接面板用 conn-field。 */
  testIdPrefix?: string;
}

export function SettingFieldInput({ field, value, onChange, testIdPrefix = 'set-field' }: Props) {
  const { styles, cx } = useStyles();
  const [tipOpen, setTipOpen] = useState(false);
  const testId = `${testIdPrefix}-${field.key}`;
  const storeBoolean = field.storeBoolean ?? 'one-zero';
  const on =
    storeBoolean === 'true-empty'
      ? value === 'true'
      : value === '1' || value.toLowerCase() === 'true' || (value === '' && field.default === '1');

  const control = () => {
    switch (field.type) {
      case 'boolean':
        return (
          <Switch
            data-testid={testId}
            checked={on}
            onChange={(checked) => onChange(checked ? (storeBoolean === 'true-empty' ? 'true' : '1') : storeBoolean === 'true-empty' ? '' : '0')}
          />
        );
      case 'number':
        return (
          <InputNumber
            data-testid={testId}
            value={value === '' ? null : Number(value)}
            placeholder={field.placeholder}
            min={field.min}
            max={field.max}
            onChange={(n) => onChange(n == null ? '' : String(n))}
          />
        );
      case 'select':
        return (
          <Select
            data-testid={testId}
            value={value || field.default || undefined}
            placeholder={field.placeholder}
            options={field.options}
            style={{ minWidth: 180 }}
            onChange={(v) => onChange(v ?? '')}
          />
        );
      case 'model':
        return (
          <ModelSelectField
            value={value}
            placeholder={field.placeholder}
            testId={testId}
            onChange={onChange}
          />
        );
      case 'model-list':
        return <ModelListField value={value} testId={testId} onChange={onChange} />;
      case 'slider': {
        const min = field.min ?? 0;
        const max = field.max ?? 100;
        const fallback = field.default != null && field.default !== '' ? Number(field.default) : min;
        const parsed = value.trim() === '' ? fallback : Number(value);
        const shown = Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
        return (
          <div data-testid={testId} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Slider
              aria-label={field.label}
              min={min}
              max={max}
              step={1}
              value={shown}
              tooltip={{ open: tipOpen, formatter: (n) => `${n}%` }}
              style={{ flex: 1, margin: 0 }}
              onChange={(n) => {
                setTipOpen(true);
                onChange(String(n));
              }}
              onChangeComplete={() => setTipOpen(false)}
            />
            <span style={{ width: 40, textAlign: 'end', fontVariantNumeric: 'tabular-nums' }}>{shown}%</span>
          </div>
        );
      }
      case 'password':
        return (
          <Input.Password
            data-testid={testId}
            value={value}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      default:
        return (
          <Input
            data-testid={testId}
            value={value}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        );
    }
  };

  // 开关/数字/下拉走两端对齐行；长文本类控件占整行宽度。
  const inline = field.type === 'boolean' || field.type === 'number' || field.type === 'select' || field.type === 'model';

  if (inline) {
    return (
      <div className={styles.row}>
        <div className={styles.meta}>
          <div className={styles.label}>{field.label}</div>
          {field.description ? <div className={styles.desc}>{field.description}</div> : null}
        </div>
        <div className={styles.control}>{control()}</div>
      </div>
    );
  }

  return (
    <Flexbox gap={6} style={{ paddingBlock: 10 }}>
      <div className={styles.label}>{field.label}</div>
      {field.description ? <div className={styles.desc}>{field.description}</div> : null}
      <div className={cx(styles.wide)}>{control()}</div>
    </Flexbox>
  );
}
