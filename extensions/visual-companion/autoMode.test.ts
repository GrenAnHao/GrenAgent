import { expect, test } from 'vitest';
import { detectMode } from './autoMode.js';

test('inline: 简单选项无 mockup', () => {
  const html = '<div class="options"><div class="option">A</div></div>';
  expect(detectMode(html)).toBe('inline');
});

test('panel: 含 mockup 类', () => {
  const html = '<div class="mockup"><div class="mockup-body">...</div></div>';
  expect(detectMode(html)).toBe('panel');
});

test('panel: 含 split 类', () => {
  const html = '<div class="split"><div class="mockup">left</div></div>';
  expect(detectMode(html)).toBe('panel');
});

test('panel: 含 cards 类', () => {
  const html = '<div class="cards"><div class="card">item</div></div>';
  expect(detectMode(html)).toBe('panel');
});

test('panel: 含 mock-nav', () => {
  const html = '<div class="mock-nav">Logo</div>';
  expect(detectMode(html)).toBe('panel');
});

test('inline: 空字符串', () => {
  expect(detectMode('')).toBe('inline');
});
