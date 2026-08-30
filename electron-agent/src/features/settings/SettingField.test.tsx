import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingFieldInput } from './SettingField';

afterEach(cleanup);

describe('SettingFieldInput', () => {
  it('boolean renders a switch and toggles 1/0', () => {
    const onChange = vi.fn();
    render(<SettingFieldInput field={{ key: 'X', label: 'X', type: 'boolean' }} value="0" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('set-field-X'));
    expect(onChange).toHaveBeenCalledWith('1');
  });

  it('boolean with default "1" shows on when value is empty (unset)', () => {
    render(<SettingFieldInput field={{ key: 'D', label: 'D', type: 'boolean', default: '1' }} value="" onChange={() => {}} />);
    expect(screen.getByTestId('set-field-D').getAttribute('aria-checked')).toBe('true');
  });

  it('boolean without default shows off when value is empty (unset)', () => {
    render(<SettingFieldInput field={{ key: 'E', label: 'E', type: 'boolean' }} value="" onChange={() => {}} />);
    expect(screen.getByTestId('set-field-E').getAttribute('aria-checked')).toBe('false');
  });

  it('text input reflects value and emits changes', () => {
    const onChange = vi.fn();
    render(<SettingFieldInput field={{ key: 'Y', label: 'Y', type: 'text' }} value="a" onChange={onChange} />);
    const el = screen.getByTestId('set-field-Y') as HTMLInputElement;
    expect(el.value).toBe('a');
    fireEvent.change(el, { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('renders description and honors testIdPrefix', () => {
    render(
      <SettingFieldInput
        field={{ key: 'Z', label: 'Z', type: 'text', description: 'hello desc' }}
        value=""
        onChange={() => {}}
        testIdPrefix="conn-field"
      />,
    );
    expect(screen.getByTestId('conn-field-Z')).toBeTruthy();
    expect(screen.getByText('hello desc')).toBeTruthy();
  });

  // antd Select 在 jsdom 下渲染较慢（getComputedStyle 伪元素未实现），放宽超时避免环境性 flaky。
  it(
    'select renders with its testid',
    () => {
      const onChange = vi.fn();
      render(
        <SettingFieldInput
          field={{
            key: 'S',
            label: 'S',
            type: 'select',
            options: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' },
            ],
          }}
          value="a"
          onChange={onChange}
        />,
      );
      expect(screen.getByTestId('set-field-S')).toBeTruthy();
    },
    30000,
  );
});
