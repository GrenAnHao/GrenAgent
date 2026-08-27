import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { EditPreview } from './EditPreview';

vi.mock('./LazyHighlighter', () => ({
  LazySyntaxHighlighter: ({ children, language }: { children: React.ReactNode; language: string }) => (
    <div data-language={language} data-testid="syntax-highlighter">{children}</div>
  ),
}));

afterEach(cleanup);

const wrap = (ui: React.ReactElement) => render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);

describe('EditPreview', () => {
  it('shows five lines around the changed hunk and keeps the filename only', () => {
    wrap(
      <EditPreview
        path="D:/OneDrive/Project Files/mcp/JSReverser-MCP/src/services/GeminiProvider.ts"
        diff={['@@ -10,7 +10,7 @@', ' line 10', ' line 11', ' line 12', ' line 13', ' line 14', '-old value', '+new value', ' line 17', ' line 18', ' line 19', ' line 20', ' line 21', ' line 22'].join('\n')}
      />,
    );

    expect(screen.getByText('GeminiProvider.ts')).toBeTruthy();
    expect(screen.queryByText(/D:\/OneDrive/)).toBeNull();
    const highlightedCode = screen.getByTestId('syntax-highlighter').textContent;
    expect(highlightedCode).toContain('line 10');
    expect(highlightedCode).toContain('line 21');
    expect(highlightedCode).toContain('old value');
    expect(highlightedCode).toContain('new value');
    expect(screen.getByTestId('edit-preview-scroll')).toBeTruthy();
    expect(screen.getByTestId('edit-preview-language')).toHaveAttribute('data-language', 'typescript');
  });

  it('shows the raw no-op error instead of presenting a successful change', () => {
    wrap(
      <EditPreview
        path="GeminiProvider.ts"
        oldText="same"
        newText="same"
        resultText="No changes made. The replacement produced identical content."
      />,
    );

    expect(screen.getByText(/replacement produced identical content/)).toBeTruthy();
    expect(screen.queryByText('+ same')).toBeNull();
  });

  it('parses the display diff emitted by the Pi edit tool', () => {
    wrap(
      <EditPreview
        path="src/GeminiProvider.ts"
        diff={' 129  * @returns Analysis result\n-130  throw new Error();\n+130  return request();\n 131 }'}
      />,
    );

    const highlightedCode = screen.getByTestId('syntax-highlighter').textContent;
    expect(highlightedCode).toContain('throw new Error();');
    expect(highlightedCode).toContain('return request();');
    expect(screen.getAllByText('130')).toHaveLength(2);
  });

  it('renders the preview with one syntax highlighter', () => {
    wrap(
      <EditPreview
        path="src/GeminiProvider.ts"
        diff={' 129  context\n-130  old value\n+130  new value\n 131  context'}
      />,
    );

    expect(screen.getAllByTestId('syntax-highlighter')).toHaveLength(1);
  });
});
