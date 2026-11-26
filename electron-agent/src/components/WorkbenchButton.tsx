import { Button as LobeButton } from '@lobehub/ui';
import type { ComponentProps } from 'react';

// Lobe varies the default shape by theme, and gives filled buttons a neutral color even when dangerous.
export function WorkbenchButton({ variant = 'filled', color, danger, ...props }: ComponentProps<typeof LobeButton>) {
  return <LobeButton {...props} variant={variant} color={color ?? (danger ? 'danger' : undefined)} danger={danger} />;
}
