import { Icon } from '@lobehub/ui';
import { SquareSlash } from 'lucide-react';
import { pillStyles } from './commandPillStyles';

const MAX_VALUE_CHARS = 32;

function clampValue(value: string): string {
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS - 1)}…` : value;
}

/** 只读命令胶囊：发出去的气泡里用。 */
export function CommandPillView({ name, args }: { name: string; args: ReadonlyArray<{ name: string; value: string }> }) {
  return (
    <span className={pillStyles.pill} data-testid="command-pill" data-command={name} data-noarg={args.length === 0}>
      <span className={pillStyles.command}>
        <Icon icon={SquareSlash} size={13} />
        {name}
      </span>
      {args.map((arg) => (
        <span
          key={arg.name}
          className={pillStyles.arg}
          data-testid="command-pill-arg"
          title={arg.value.length > MAX_VALUE_CHARS ? arg.value : undefined}
        >
          <span className={pillStyles.key}>{arg.name}</span>
          <span>{clampValue(arg.value)}</span>
        </span>
      ))}
    </span>
  );
}
