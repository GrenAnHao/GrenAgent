import { ThemeProvider } from '@lobehub/ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { WorkbenchButton } from './WorkbenchButton';

afterEach(cleanup);

it.each(['light', 'dark'] as const)('keeps button variants independent of %s appearance', (mode) => {
  render(
    <ThemeProvider appearance={mode} themeMode={mode} enableGlobalStyle={false} enableCustomFonts={false}>
      <WorkbenchButton>Refresh</WorkbenchButton>
      <WorkbenchButton variant="outlined">Outline</WorkbenchButton>
      <WorkbenchButton type="primary">Add</WorkbenchButton>
      <WorkbenchButton danger>Delete</WorkbenchButton>
    </ThemeProvider>,
  );
  for (const [name, variant] of [['Refresh', 'filled'], ['Outline', 'outlined'], ['Add', 'solid'], ['Delete', 'filled']]) {
    expect(screen.getByRole('button', { name }).classList.contains(`ant-btn-variant-${variant}`)).toBe(true);
  }
  expect(screen.getByRole('button', { name: 'Delete' }).classList.contains('ant-btn-color-dangerous')).toBe(true);
});
