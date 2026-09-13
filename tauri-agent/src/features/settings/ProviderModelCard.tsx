import { Icon } from '@lobehub/ui';
import { Checkbox, Collapse, Input, InputNumber, Select } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import {
  THINKING_FORMAT_OPTIONS,
  THINKING_LEVEL_ROWS,
  groupsForEditor,
  showsThinkingFormat,
  thinkingFormatChip,
  type CompatField,
} from './modelCompatCatalog';
import { defaultThinkingLevelMap, type ModelCompat, type ThinkingLevel, type UiModel } from './providerConfigAdapter';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    padding: 10px;
    margin-block-end: 10px;
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: 8px;
  `,
  grow: css`
    flex: 1 1 0;
    min-width: 0;
  `,
  chk: css`
    flex: 0 0 auto;
    white-space: nowrap;
  `,
  ctx: css`
    flex: 0 0 auto;
    width: 132px;
  `,
  chip: css`
    flex: 0 0 auto;
    padding: 1px 8px;
    border-radius: 999px;
    background: ${cssVar.colorPrimaryBg};
    color: ${cssVar.colorPrimary};
    font-size: 11px;
    white-space: nowrap;
  `,
  iconBtn: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px 10px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius};
    background: transparent;
    color: ${cssVar.colorText};
    cursor: pointer;
    font-size: 12px;
  `,
  delBtn: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius};
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;
    &:hover {
      color: ${cssVar.colorError};
      border-color: ${cssVar.colorError};
    }
  `,
  body: css`
    margin-block-start: 12px;
    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  split: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-block-end: 12px;
  `,
  field: css`
    min-width: 0;
  `,
  lab: css`
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  en: css`
    display: block;
    margin-block-start: 2px;
    margin-block-end: 4px;
    color: ${cssVar.colorTextDescription};
    font-size: 11px;
  `,
  help: css`
    color: ${cssVar.colorTextDescription};
    font-size: 12px;
    line-height: 1.55;
  `,
  map: css`
    display: grid;
    grid-template-columns: 88px 1fr 72px;
    gap: 6px 8px;
    align-items: center;
    margin: 8px 0 12px;
  `,
  mapHead: css`
    color: ${cssVar.colorTextDescription};
    font-size: 12px;
  `,
  compatRow: css`
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 10px 0;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    &:last-child {
      border-block-end: 0;
    }
  `,
}));

function hasImage(input: UiModel['input']): boolean {
  return !!input?.includes('image');
}

function FieldLabel({ label, en, help }: { label: string; en: string; help: string }) {
  return (
    <>
      <div className={styles.lab}>{label}</div>
      <div className={styles.en}>{en}</div>
      <p className={styles.help}>{help}</p>
    </>
  );
}

function compatValue(compat: ModelCompat | undefined, key: string): unknown {
  return compat?.[key];
}

function setCompat(model: UiModel, key: string, value: unknown): Partial<UiModel> {
  const next = { ...(model.compat ?? {}) };
  if (value === undefined || value === '') delete next[key];
  else next[key] = value;
  const patch: Partial<UiModel> = { compat: Object.keys(next).length ? next : undefined };
  if (key === 'forceAdaptiveThinking') patch.forceAdaptiveThinking = value === true;
  return patch;
}

function renderCompatControl(field: CompatField, model: UiModel, index: number, onChange: (patch: Partial<UiModel>) => void) {
  const raw = compatValue(model.compat, field.key);
  if (field.kind === 'bool') {
    return (
      <Checkbox
        data-testid={`prov-compat-${field.key}-${index}`}
        checked={raw === true}
        onChange={(e) => onChange(setCompat(model, field.key, e.target.checked))}
      />
    );
  }
  if (field.kind === 'select') {
    return (
      <Select
        data-testid={`prov-compat-${field.key}-${index}`}
        allowClear
        value={typeof raw === 'string' ? raw : undefined}
        placeholder={field.emptyLabel}
        options={field.options}
        style={{ width: '100%', marginTop: 8 }}
        variant="filled"
        onChange={(v) => onChange(setCompat(model, field.key, v))}
      />
    );
  }
  if (field.kind === 'number') {
    return (
      <InputNumber
        data-testid={`prov-compat-${field.key}-${index}`}
        value={typeof raw === 'number' ? raw : undefined}
        placeholder={field.placeholder}
        style={{ width: '100%', marginTop: 8 }}
        variant="filled"
        onChange={(v) => onChange(setCompat(model, field.key, typeof v === 'number' ? v : undefined))}
      />
    );
  }
  return (
    <Input
      data-testid={`prov-compat-${field.key}-${index}`}
      value={typeof raw === 'string' ? raw : raw != null ? String(raw) : ''}
      placeholder={field.placeholder}
      style={{ marginTop: 8 }}
      variant="filled"
      onChange={(e) => onChange(setCompat(model, field.key, e.target.value || undefined))}
    />
  );
}

export interface ProviderModelCardProps {
  model: UiModel;
  index: number;
  api: string | undefined;
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<UiModel>) => void;
  onRemove: () => void;
}

export function ProviderModelCard({ model, index, api, expanded, onToggle, onChange, onRemove }: ProviderModelCardProps) {
  const formatChip = thinkingFormatChip(model.thinkingFormat);
  const groups = groupsForEditor(api);
  const showFormat = showsThinkingFormat(api);

  const setReasoning = (checked: boolean) => {
    onChange({
      reasoning: checked ? true : undefined,
      thinkingLevelMap: checked ? (model.thinkingLevelMap ?? defaultThinkingLevelMap(api, model.id)) : undefined,
      forceAdaptiveThinking: checked && api === 'anthropic-messages' ? (model.forceAdaptiveThinking ?? true) : undefined,
    });
  };

  const setLevelVisible = (level: ThinkingLevel, visible: boolean) => {
    const map = { ...(model.thinkingLevelMap ?? {}) };
    if (!visible) {
      map[level] = null;
    } else {
      const prev = map[level];
      map[level] = typeof prev === 'string' ? prev : level === 'off' ? '' : level;
    }
    onChange({ thinkingLevelMap: map });
  };

  const setLevelValue = (level: ThinkingLevel, value: string) => {
    const map = { ...(model.thinkingLevelMap ?? {}) };
    map[level] = value;
    onChange({ thinkingLevelMap: map });
  };

  return (
    <div className={styles.card} data-testid={`prov-model-card-${index}`}>
      <div className={styles.row}>
        <Input
          className={styles.grow}
          data-testid={`prov-model-id-${index}`}
          value={model.id}
          placeholder="模型 ID"
          variant="filled"
          onChange={(e) => onChange({ id: e.target.value })}
        />
        <Input
          className={styles.grow}
          data-testid={`prov-model-name-${index}`}
          value={model.name ?? ''}
          placeholder="显示名（可选）"
          variant="filled"
          onChange={(e) => onChange({ name: e.target.value || undefined })}
        />
        <Checkbox
          className={styles.chk}
          data-testid={`prov-model-reasoning-${index}`}
          checked={!!model.reasoning}
          onChange={(e) => setReasoning(e.target.checked)}
        >
          推理
        </Checkbox>
        <Checkbox
          className={styles.chk}
          data-testid={`prov-model-image-${index}`}
          checked={hasImage(model.input)}
          onChange={(e) => onChange({ input: e.target.checked ? ['text', 'image'] : ['text'] })}
        >
          图片
        </Checkbox>
        {formatChip ? <span className={styles.chip}>{formatChip}</span> : null}
        <InputNumber
          className={styles.ctx}
          data-testid={`prov-model-context-${index}`}
          value={model.contextWindow}
          placeholder="上下文窗口"
          min={0}
          step={1000}
          controls={false}
          variant="filled"
          title="上下文窗口（tokens），如 200000 / 1000000"
          formatter={(v) => (v ? String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '')}
          parser={(v) => (v ? Number(v.replace(/,/g, '')) : 0)}
          onChange={(v) => onChange({ contextWindow: typeof v === 'number' ? v : undefined })}
        />
        <button type="button" data-testid={`prov-model-expand-${index}`} className={styles.iconBtn} onClick={onToggle}>
          <Icon icon={expanded ? ChevronUp : ChevronDown} size={14} />
          {expanded ? '收起' : '展开'}
        </button>
        <button type="button" data-testid={`prov-model-del-${index}`} className={styles.delBtn} onClick={onRemove}>
          <Icon icon={Trash2} size={14} />
        </button>
      </div>

      {expanded ? (
        <div className={styles.body}>
          <div className={styles.split}>
            <div className={styles.field}>
              <FieldLabel label="支持扩展思考" en="reasoning" help="打开后，对话里才会出现思考档位。关掉则只发普通回复。" />
              <div style={{ marginTop: 8 }}>
                <Checkbox checked={!!model.reasoning} onChange={(e) => setReasoning(e.target.checked)}>
                  {model.reasoning ? '已开启' : '未开启'}
                </Checkbox>
              </div>
            </div>
            <div className={styles.field}>
              <FieldLabel label="支持图片输入" en="input: image" help="打开后，这个模型可以接收粘贴/上传的图片。纯文本模型请关掉。" />
              <div style={{ marginTop: 8 }}>
                <Checkbox
                  checked={hasImage(model.input)}
                  onChange={(e) => onChange({ input: e.target.checked ? ['text', 'image'] : ['text'] })}
                >
                  {hasImage(model.input) ? '已开启' : '未开启'}
                </Checkbox>
              </div>
            </div>
            <div className={styles.field}>
              <FieldLabel label="上下文窗口" en="contextWindow" help="一次对话最多能塞进多少 token。填服务商文档里的值。" />
              <InputNumber
                value={model.contextWindow}
                style={{ width: '100%', marginTop: 8 }}
                min={0}
                controls={false}
                variant="filled"
                onChange={(v) => onChange({ contextWindow: typeof v === 'number' ? v : undefined })}
              />
            </div>
            <div className={styles.field}>
              <FieldLabel label="最大输出" en="maxTokens" help="单次回复最多生成多少 token。太小会截断，太大有的代理会报错。" />
              <InputNumber
                data-testid={`prov-model-max-tokens-${index}`}
                value={model.maxTokens}
                style={{ width: '100%', marginTop: 8 }}
                min={0}
                controls={false}
                variant="filled"
                onChange={(v) => onChange({ maxTokens: typeof v === 'number' ? v : undefined })}
              />
            </div>
            <div className={styles.field}>
              <FieldLabel label="输入价格" en="cost.input" help="每百万输入 token 的价格，用于用量统计。没有就填 0。" />
              <InputNumber
                data-testid={`prov-model-cost-in-${index}`}
                value={model.cost?.input}
                style={{ width: '100%', marginTop: 8 }}
                min={0}
                controls={false}
                variant="filled"
                onChange={(v) => onChange({ cost: { ...model.cost, input: typeof v === 'number' ? v : undefined } })}
              />
            </div>
            <div className={styles.field}>
              <FieldLabel label="输出价格" en="cost.output" help="每百万输出 token 的价格。没有就填 0。" />
              <InputNumber
                data-testid={`prov-model-cost-out-${index}`}
                value={model.cost?.output}
                style={{ width: '100%', marginTop: 8 }}
                min={0}
                controls={false}
                variant="filled"
                onChange={(v) => onChange({ cost: { ...model.cost, output: typeof v === 'number' ? v : undefined } })}
              />
            </div>
          </div>

          {showFormat ? (
            <div className={styles.field} style={{ marginBottom: 12 }}>
              <FieldLabel
                label="思考协议"
                en="compat.thinkingFormat"
                help="同一套 OpenAI 兼容接口，各家思考参数写法不同。选错会出现「能聊但不能思考」或 400。"
              />
              <Select
                data-testid={`prov-model-format-${index}`}
                allowClear
                virtual={false}
                value={model.thinkingFormat}
                options={THINKING_FORMAT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                style={{ width: '100%', maxWidth: 480, marginTop: 8 }}
                variant="filled"
                onChange={(v) => onChange({ thinkingFormat: v })}
              />
            </div>
          ) : null}

          {model.reasoning ? (
            <>
              <div className={styles.lab}>思考档位对照</div>
              <div className={styles.en}>thinkingLevelMap</div>
              <p className={styles.help}>左边是对话里选的档，右边是发给服务商的值。关掉「出现」则对话里看不到这一档。</p>
              <div className={styles.map}>
                <div className={styles.mapHead}>对话档位</div>
                <div className={styles.mapHead}>发给服务商的值</div>
                <div className={styles.mapHead}>出现</div>
                {THINKING_LEVEL_ROWS.map(({ level, label }) => {
                  const raw = model.thinkingLevelMap?.[level];
                  const visible = raw !== null && raw !== undefined;
                  return (
                    <div key={level} style={{ display: 'contents' }}>
                      <div>{label}</div>
                      <Input
                        data-testid={`prov-model-map-${level}-${index}`}
                        value={typeof raw === 'string' ? raw : ''}
                        placeholder={visible ? '可不填' : ''}
                        disabled={!visible}
                        variant="filled"
                        onChange={(e) => setLevelValue(level, e.target.value)}
                      />
                      <Checkbox
                        data-testid={`prov-model-map-on-${level}-${index}`}
                        checked={visible}
                        onChange={(e) => setLevelVisible(level, e.target.checked)}
                      >
                        {visible ? '显示' : '隐藏'}
                      </Checkbox>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

          <Collapse
            bordered={false}
            defaultActiveKey={['thinking']}
            destroyOnHidden
            items={groups.map((g) => ({
              key: g.id,
              label: g.title,
              children: g.fields.map((field) => (
                <div key={field.key} className={field.kind === 'bool' ? styles.compatRow : styles.field} style={field.kind === 'bool' ? undefined : { margin: '10px 0' }}>
                  {field.kind === 'bool' ? (
                    <>
                      {renderCompatControl(field, model, index, onChange)}
                      <span>
                        <div className={styles.lab}>{field.label}</div>
                        <div className={styles.en}>{field.en}</div>
                        <p className={styles.help}>{field.help}</p>
                      </span>
                    </>
                  ) : (
                    <>
                      <FieldLabel label={field.label} en={field.en} help={field.help} />
                      {renderCompatControl(field, model, index, onChange)}
                    </>
                  )}
                </div>
              )),
            }))}
          />
        </div>
      ) : null}
    </div>
  );
}
