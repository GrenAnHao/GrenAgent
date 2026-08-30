import { Flexbox } from '@lobehub/ui';
import { Select } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { suggestModels, type Capability } from './capabilityModelPresets';
import { useProviderModelData } from './providerModelData';
import type { SettingField } from './settingsSchema';

const styles = createStaticStyles(({ css }) => ({
  label: css`
    font-size: 13px;
    color: ${cssVar.colorText};
  `,
  desc: css`
    margin-block-start: 2px;
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
}));

interface Props {
  field: SettingField; // key=供应商 env、modelKey=模型 env、capability=能力
  values: Record<string, string>;
  setValue: (key: string, v: string) => void;
}

/**
 * 能力模型选择（Embedding / 图像 / TTS）：两步式「先选供应商 → 再选模型」。
 * 供应商只列当前可用（已成功添加）的、显示名字；模型下拉 = 该供应商可用模型 + 能力预设（如
 * openai 的 embedding/tts/image），去重。这些能力模型不在对话模型注册表里，故并入预设兜底。
 */
export function CapabilityModelField({ field, values, setValue }: Props) {
  const { providerOptions, nameOf, modelsFor } = useProviderModelData();

  const provider = values[field.key] ?? '';
  const model = values[field.modelKey ?? ''] ?? '';
  const cap = (field.capability ?? 'embedding') as Capability;

  const provOpts = [...providerOptions];
  // 当前值的供应商若不在可用列表，补一项保留显示。
  if (provider && !provOpts.some((o) => o.value === provider)) {
    provOpts.unshift({ label: nameOf(provider), value: provider });
  }

  // 该供应商可用模型 + 能力预设（embedding/tts/image），去重；再保留当前值。
  const modelOpts = modelsFor(provider);
  for (const m of suggestModels(provider, cap)) {
    if (!modelOpts.some((o) => o.value === m)) modelOpts.push({ label: m, value: m });
  }
  if (model && !modelOpts.some((o) => o.value === model)) {
    modelOpts.unshift({ label: model, value: model });
  }

  return (
    <Flexbox gap={6} style={{ paddingBlock: 10 }}>
      <div className={styles.label}>{field.label}</div>
      {field.description ? <div className={styles.desc}>{field.description}</div> : null}
      <Flexbox horizontal gap={8}>
        <Select
          data-testid={`set-field-${field.key}`}
          value={provider || undefined}
          placeholder="供应商"
          style={{ minWidth: 160 }}
          options={provOpts}
          allowClear
          showSearch
          optionFilterProp="label"
          onChange={(v) => {
            setValue(field.key, v ?? '');
            // 换/清供应商即清掉旧模型（多半不属于新供应商）。
            setValue(field.modelKey ?? '', '');
          }}
        />
        <Select
          data-testid={`set-field-${field.modelKey}`}
          value={model || undefined}
          placeholder="模型"
          style={{ flex: 1, minWidth: 160 }}
          options={modelOpts}
          disabled={!provider}
          allowClear
          showSearch
          optionFilterProp="label"
          onChange={(v) => setValue(field.modelKey ?? '', v ?? '')}
        />
      </Flexbox>
    </Flexbox>
  );
}
