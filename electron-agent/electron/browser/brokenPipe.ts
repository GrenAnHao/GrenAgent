export function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EPIPE'
  );
}

export function ignoreBrokenPipeStreamError(error: Error): void {
  if (!isBrokenPipeError(error)) throw error;
}

export function handleUncaughtException(error: unknown, onFatal: (error: Error) => void): void {
  if (isBrokenPipeError(error)) return;
  onFatal(error instanceof Error ? error : new Error(String(error)));
}

export function installBrokenPipeGuards(onFatal: (error: Error) => void): () => void {
  const onUncaught = (error: unknown) => handleUncaughtException(error, onFatal);
  process.stdout.on('error', ignoreBrokenPipeStreamError);
  process.stderr.on('error', ignoreBrokenPipeStreamError);
  process.on('uncaughtException', onUncaught);
  return () => {
    process.stdout.off('error', ignoreBrokenPipeStreamError);
    process.stderr.off('error', ignoreBrokenPipeStreamError);
    process.off('uncaughtException', onUncaught);
  };
}

