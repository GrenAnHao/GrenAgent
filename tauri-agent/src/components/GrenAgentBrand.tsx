import { Flexbox } from '@lobehub/ui';

/**
 * 标题栏字样。π 已迁到空会话标题，不再和折叠开关挤在品牌组件里。
 */
export function GrenAgentBrand() {
  return (
    <Flexbox horizontal align="center" gap={8}>
      <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: 1, color: 'var(--gren-fg-muted, #9aa1ac)' }}>
        Gren<span style={{ color: 'var(--gren-fg, #e6e8ec)' }}>Agent</span>
      </span>
    </Flexbox>
  );
}
