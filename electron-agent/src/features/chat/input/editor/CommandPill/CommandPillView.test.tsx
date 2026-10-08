// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CommandPillView } from './CommandPillView';

describe('CommandPillView', () => {
  it('显示命令名和每个参数的名字与值', () => {
    render(<CommandPillView name="refactor" args={[{ name: 'file', value: 'src/a.ts' }, { name: 'style', value: 'fp' }]} />);
    const pill = screen.getByTestId('command-pill');
    expect(pill).toHaveAttribute('data-command', 'refactor');
    expect(pill).toHaveTextContent('refactor');
    const args = screen.getAllByTestId('command-pill-arg');
    expect(args.map((arg) => arg.textContent)).toEqual(['filesrc/a.ts', 'stylefp']);
  });

  it('超过 32 个字符的值截断，悬停显示完整值', () => {
    const long = 'x'.repeat(40);
    render(<CommandPillView name="a" args={[{ name: 'v', value: long }]} />);
    const arg = screen.getByTestId('command-pill-arg');
    expect(arg).toHaveAttribute('title', long);
    expect(arg.textContent).toBe(`v${'x'.repeat(31)}…`);
  });

  it('没有参数时只有命令名', () => {
    render(<CommandPillView name="review" args={[]} />);
    expect(screen.queryByTestId('command-pill-arg')).not.toBeInTheDocument();
    expect(screen.getByTestId('command-pill')).toHaveAttribute('data-noarg', 'true');
  });
});
