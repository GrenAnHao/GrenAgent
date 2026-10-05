import { describe, expect, it } from 'vitest';
import { menuHeightAboveAnchor } from './SlashBoxMenu';

describe('menuHeightAboveAnchor', () => {
  it('底部输入框上方空间够时，高度不超过 360', () => {
    expect(menuHeightAboveAnchor(800, 900)).toBe(360);
  });

  it('编辑框靠近标题栏时，菜单停在标题栏下面', () => {
    expect(menuHeightAboveAnchor(180, 900)).toBe(180 - 38 - 16);
  });

  it('短窗口里也不超过 46% 视口', () => {
    expect(menuHeightAboveAnchor(500, 600)).toBe(276);
  });
});
