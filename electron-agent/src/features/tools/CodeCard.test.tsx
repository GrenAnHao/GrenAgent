import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CodeCard } from './CodeCard';

afterEach(cleanup);

describe('CodeCard', () => {
  it('shows the file name and no collapse button', () => {
    render(
      <CodeCard fileName="secret.txt">
        <pre>hello</pre>
      </CodeCard>,
    );
    const header = screen.getByTestId('code-card-header');
    expect(screen.getByTestId('code-card-name').textContent).toBe('secret.txt');
    expect(header.querySelector('button')).toBeNull();
  });

  it('shows the language label instead of the icon file name', () => {
    render(
      <CodeCard language="typescript">
        <pre>const x = 1</pre>
      </CodeCard>,
    );
    expect(screen.getByTestId('code-card-name').textContent).toBe('TypeScript');
    expect(screen.getByTestId('code-card-header').textContent).not.toContain('file.ts');
  });

  it('hides stats when both counts are zero', () => {
    render(
      <CodeCard added={0} deleted={0} fileName="a.ts">
        <pre>x</pre>
      </CodeCard>,
    );
    expect(screen.queryByTestId('code-card-stats')).toBeNull();
  });

  it('shows non-zero stats on the right', () => {
    render(
      <CodeCard added={6} deleted={1} fileName="a.ts">
        <pre>x</pre>
      </CodeCard>,
    );
    const stats = screen.getByTestId('code-card-stats');
    expect(stats.textContent).toContain('+6');
    expect(stats.textContent).toContain('-1');
  });

  it('does not reserve a horizontal scrollbar until hover', () => {
    render(
      <CodeCard fileName="a.ts">
        <pre>short</pre>
      </CodeCard>,
    );
    const body = screen.getByTestId('code-card-body');
    const css = [...document.querySelectorAll('style')].map((node) => node.textContent ?? '').join('\n');
    expect(body.className.length).toBeGreaterThan(0);
    expect(css).toContain('scrollbar-width:none');
    expect(css).toContain('scrollbar-width:thin');
  });
});
