import { Input, Select } from 'antd';
import { useEffect, useState } from 'react';
import { useProviderModelData } from './providerModelData';

interface ModelSelectFieldProps {
  value: string;
  placeholder?: string;
  testId?: string;
  onChange: (v: string) => void;
}

/** 把约定值 "provider/id" 拆成供应商与模型 id（按首个 '/' 切，首段为供应商）。 */
function splitModelValue(v: string): { provider: string; id: string } {
  const idx = v.indexOf('/');
  if (idx === -1) return { provider: '', id: v };
  return { provider: v.slice(0, idx), id: v.slice(idx + 1) };
}

/**
 * 全局功能模型选择（标题/子代理/记忆等）：两步式「先选供应商 → 再选该供应商的可用模型」。
 * 供应商只列当前可用（已成功添加）的、显示名字；模型只列该供应商拥有的。值用约定的 "provider/id"。
 * 拿不到任何可用模型（无对话 / 冷启动 / 空）时回退手填 Input，避免无法配置。
 */
export function ModelSelectField({ value, placeholder, testId, onChange }: ModelSelectFieldProps) {
  const { ready, providerOptions, nameOf, modelsFor } = useProviderModelData();

  const parsed = splitModelValue(value);
  // 选中的供应商用本地态：换供应商到选定新模型之间已提交值尚不完整，
  // 此过程不能依赖已提交的 value。仅在 value 带供应商时同步回本地（加载/重置）。
  const [provider, setProvider] = useState(parsed.provider);
  useEffect(() => {
    const p = splitModelValue(value).provider;
    if (p) setProvider(p);
  }, [value]);

  if (!ready) {
    return (
      <Input
        data-testid={testId}
        value={value}
        placeholder={placeholder}
        style={{ minWidth: 220 }}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  const provOpts = [...providerOptions];
  // 当前值的供应商若不在可用列表（历史配置 / 列表变动），补一项保留显示。
  if (provider && !provOpts.some((o) => o.value === provider)) {
    provOpts.unshift({ label: nameOf(provider), value: provider });
  }

  const modelOpts = modelsFor(provider);
  // 当前值的模型若不在该供应商可用列表，补一项保留显示，避免被清空。
  if (provider === parsed.provider && parsed.id && !modelOpts.some((o) => o.value === parsed.id)) {
    modelOpts.unshift({ label: parsed.id, value: parsed.id });
  }

  // 供应商与已提交值一致时才回显模型；换了供应商（尚未选模型）则置空。
  const modelValue = provider === parsed.provider ? parsed.id : '';

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <Select
        data-testid={testId ? `${testId}-provider` : undefined}
        value={provider || undefined}
        options={provOpts}
        placeholder="供应商"
        style={{ minWidth: 130 }}
        allowClear
        showSearch
        optionFilterProp="label"
        onChange={(p) => {
          const next = p ?? '';
          setProvider(next);
          // 清空供应商即清空该设置；换到新供应商则等选完模型再提交完整值。
          if (!next) onChange('');
        }}
      />
      <Select
        data-testid={testId}
        value={modelValue || undefined}
        options={modelOpts}
        placeholder={placeholder ?? '模型'}
        style={{ minWidth: 200 }}
        disabled={!provider}
        allowClear
        showSearch
        optionFilterProp="label"
        onChange={(id) => onChange(id ? `${provider}/${id}` : '')}
      />
    </div>
  );
}
