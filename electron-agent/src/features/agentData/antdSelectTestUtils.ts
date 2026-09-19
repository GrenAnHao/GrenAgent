import { expect } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

// antd 6 Select 渲染为只读 combobox，fireEvent.change 无法驱动。
// 统一用「打开下拉 + 点击 .ant-select-item-option 选项」驱动；值断言改查显示文本。
// 注意：下拉中还存在一组隐藏的合成 role="option"（aria-label=label、textContent=value、
// 无事件），getByRole('option') 会匹配到它们——只能用于查询，不能点击。
function selectRoot(label: string | RegExp): Element {
  const combobox = screen.getByLabelText(label);
  const root = combobox.closest('.ant-select');
  if (!root) throw new Error(`aria-label=${String(label)} 对应的元素不是 antd Select`);
  return root;
}

export async function openSelect(label: string | RegExp): Promise<void> {
  const root = selectRoot(label);
  fireEvent.mouseDown(root);
  // 多个 Select 打开后各自的合成 listbox 会残留在 DOM，
  // 全局 findByRole('listbox') 不唯一，改为等待本 select 进入 open 状态。
  await waitFor(() => {
    if (!root.className.includes('ant-select-open')) throw new Error('antd Select 未打开');
  });
}

function dropdownScope(label: string | RegExp): ParentNode {
  // 测试环境下 rc-select 生成的 id 固定为 test-id，
  // 多个 Select 的 listbox id 相同；只有打开中的 dropdown 才渲染 .ant-select-item-option。
  const combobox = screen.getByLabelText(label);
  const listId = combobox.getAttribute('aria-owns') ?? combobox.getAttribute('aria-controls');
  const candidates = listId ? Array.from(document.querySelectorAll(`[id="${listId}"]`)) : [];
  const open: ParentNode[] = [];
  for (const listbox of candidates) {
    const dropdown = listbox.closest('.ant-select-dropdown');
    if (dropdown?.querySelector('.ant-select-item-option')) open.push(dropdown);
  }
  return open[open.length - 1] ?? document;
}

export async function pickSelectOption(label: string | RegExp, optionName: string | RegExp): Promise<void> {
  await openSelect(label);
  // 限定在本 select 的 dropdown 内查找，避免其它残留的打开下拉干扰同名选项。
  const scope = dropdownScope(label);
  const option = await waitFor(() => {
    const items = Array.from(scope.querySelectorAll<HTMLElement>('.ant-select-item-option'));
    const match = typeof optionName === 'string'
      ? items.find((el) => el.getAttribute('title') === optionName || el.textContent?.trim() === optionName)
      : items.find((el) => optionName.test(el.getAttribute('title') ?? '') || optionName.test(el.textContent ?? ''));
    if (!match) throw new Error(`antd Select 中找不到选项：${String(optionName)}`);
    return match;
  });
  fireEvent.click(option);
}

export function expectSelectDisplay(label: string | RegExp, expected: string | RegExp): void {
  const root = selectRoot(label);
  const text = root.querySelector<HTMLElement>('.ant-select-content')?.textContent
    ?? root.querySelector<HTMLElement>('.ant-select-placeholder')?.textContent
    ?? '';
  if (typeof expected === 'string') expect(text).toContain(expected);
  else expect(text).toMatch(expected);
}
