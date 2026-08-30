import { useHotkeys } from 'react-hotkeys-hook';

interface KeyboardShortcutsConfig {
  onNewSession?: () => void;
  onSearch?: () => void;
  onShowHelp?: () => void;
}

export function useKeyboardShortcuts({
  onNewSession,
  onSearch,
  onShowHelp,
}: KeyboardShortcutsConfig) {
  useHotkeys('ctrl+n,cmd+n', (e) => {
    e.preventDefault();
    onNewSession?.();
  });

  useHotkeys('ctrl+k,cmd+k', (e) => {
    e.preventDefault();
    onSearch?.();
  });

  useHotkeys('ctrl+/,cmd+/', (e) => {
    e.preventDefault();
    onShowHelp?.();
  });
}
