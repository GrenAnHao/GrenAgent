import { Flexbox } from '@lobehub/ui';

/**
 * 标题栏保留原来的纯文字品牌，不放图形 Logo。
 */
export function GrenAgentBrand() {
  return (
    <Flexbox horizontal align="center" gap={8}>
      <span data-testid="titlebar-brand" style={{ fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--gren-fg-muted, #9aa1ac)' }}>
        Gren<span style={{ color: 'var(--gren-fg, #e6e8ec)' }}>Agent</span>
      </span>
    </Flexbox>
  );
}
