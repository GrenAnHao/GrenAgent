import { Select } from 'antd';
import { useProviderModelData } from './providerModelData';

interface ModelListFieldProps {
  value: string;
  testId?: string;
  onChange: (v: string) => void;
}

/** 存储值是 JSON 数组字符串；坏 JSON 当空。 */
export function parseModelList(raw: string): string[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 子代理路由白名单：多选 "provider/id"。目录里没有的已存条目照常显示并标不可用，
 * 不自动删（对齐 DSH：用户授权只由用户改）。
 */
export function ModelListField({ value, testId, onChange }: ModelListFieldProps) {
  const { ready, providerOptions, nameOf, modelsFor } = useProviderModelData();
  const selected = parseModelList(value);

  const catalog = ready
    ? providerOptions.flatMap((p) => modelsFor(p.value).map((m) => ({ value: `${p.value}/${m.value}`, label: `${nameOf(p.value)} / ${m.label}` })))
    : [];
  const known = new Set(catalog.map((o) => o.value));
  const options = [
    ...catalog,
    ...selected.filter((v) => !known.has(v)).map((v) => ({ value: v, label: `${v}（不可用）` })),
  ];

  return (
    <Select
      data-testid={testId}
      mode="multiple"
      value={selected}
      options={options}
      placeholder="选择允许的路由"
      style={{ minWidth: 320 }}
      showSearch
      optionFilterProp="label"
      onChange={(next: string[]) => onChange(JSON.stringify(next))}
    />
  );
}
