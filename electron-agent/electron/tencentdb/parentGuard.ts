const PARENT_GUARD_SOURCE = [
  'process.stdin.resume();',
  'const die = () => process.exit(0);',
  'process.stdin.on("end", die);',
  'process.stdin.on("close", die);',
].join('');

// Injected via `node --import` so the child exits as soon as the parent's
// stdin pipe closes (i.e. the Electron process died without a clean shutdown).
export function parentGuardImport(): string {
  return `data:text/javascript;base64,${Buffer.from(PARENT_GUARD_SOURCE).toString('base64')}`;
}
