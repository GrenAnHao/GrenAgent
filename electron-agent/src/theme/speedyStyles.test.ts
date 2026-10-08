import { css, cx, styleManager } from 'antd-style';
import { afterEach, describe, expect, it } from 'vitest';
import { enableSpeedyStyles } from './speedyStyles';

const emotionTags = () => document.querySelectorAll('style[data-emotion]').length;

afterEach(() => {
  styleManager.sheet.isSpeedy = false;
});

describe('enableSpeedyStyles', () => {
  it('antd-style 默认实例的新规则写进同一个 style 标签，不再一条规则一个标签', () => {
    enableSpeedyStyles();
    const before = emotionTags();

    const classes = Array.from({ length: 20 }, (_, i) => cx(css`padding: ${i + 1}px;`));

    expect(new Set(classes).size).toBe(20);
    expect(emotionTags() - before).toBeLessThanOrEqual(1);
    const rules = [...document.querySelectorAll<HTMLStyleElement>('style[data-emotion]')]
      .flatMap((tag) => [...(tag.sheet?.cssRules ?? [])].map((rule) => rule.cssText));
    expect(rules.some((rule) => rule.includes('padding: 20px'))).toBe(true);
  });
});
