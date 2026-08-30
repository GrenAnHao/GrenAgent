import { Flexbox } from '@lobehub/ui';
import { Input, InputNumber, Select, Switch } from 'antd';
import { createStyles } from 'antd-style';
import type { SettingField } from './settingsSchema';
import { ModelSelectField } from './ModelSelectField';

const useStyles = createStyles(({ css, token }) => ({
  row: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-block: 10px;
  `,
  meta: css`
    min-width: 0;
  `,
  label: css`
    font-size: 13px;
    color: ${token.colorText};
  `,
  desc: css`
    margin-block-start: 2px;
    font-size: 12px;
    color: ${token.colorTextDescription};
  `,
  control: css`
    flex: 0 0 auto;
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
  const testId = `${testIdPrefix}-${field.key}`;
  // 未落盘（空值）时按 field.default 决定显示态：让「扩展侧默认开」的开关在面板上也默认显示为开，
  // 避免「行为是开、面板显示关」的错配（见 settingsSchema 的 default 字段说明）。
  const on = value === '1' || value.toLowerCase() === 'true' || (value === '' && field.default === '1');

  const control = () => {
    switch (field.type) {
      case 'boolean':
        return <Switch data-testid={testId} checked={on} onChange={(checked) => onChange(checked ? '1' : '0')} />;
      case 'number':
        return (
          <InputNumber
            data-testid={testId}
            value={value === '' ? null : Number(value)}
            placeholder={field.placeholder}
            onChange={(n) => onChange(n == null ? '' : String(n))}
          />
        );
      case 'select':
        return (
          <Select
            data-testid={testId}
            value={value || undefined}
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
