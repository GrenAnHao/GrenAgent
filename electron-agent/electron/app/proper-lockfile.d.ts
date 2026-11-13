declare module 'proper-lockfile' {
  interface LockOptions {
    realpath?: boolean;
    retries?: { retries: number; factor?: number; minTimeout?: number; maxTimeout?: number };
  }
  const lockfile: {
    lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
    lockSync(file: string, options?: LockOptions): () => void;
  };
  export default lockfile;
}
