import { useEffect, useRef, useState } from 'react';

interface Options {
  enabled?: boolean;
}

export function useThrottledValue<T>(value: T, ms: number, options?: Options): T {
  const enabled = options?.enabled ?? true;
  const [throttled, setThrottled] = useState<T>(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEnabledRef = useRef<boolean>(enabled);
  const valueRef = useRef<T>(value);
  valueRef.current = value;

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setThrottled(value);
      lastEnabledRef.current = false;
      return;
    }

    if (!lastEnabledRef.current) {
      setThrottled(value);
      lastEnabledRef.current = true;
      return;
    }
    lastEnabledRef.current = true;

    if (timerRef.current) return;

    timerRef.current = setTimeout(() => {
      setThrottled(valueRef.current);
      timerRef.current = null;
    }, ms);
  }, [value, ms, enabled]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return throttled;
}
