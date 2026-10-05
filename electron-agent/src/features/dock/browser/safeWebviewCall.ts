export function safeWebviewCall<T>(run: () => T, fallback: T, onDetached?: () => void): T {
  try {
    return run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('must be attached to the DOM') || message.includes('Render frame was disposed')) {
      onDetached?.();
      return fallback;
    }
    throw error;
  }
}
