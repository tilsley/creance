/**
 * Polling as a hook — the console's watch model IS polling (ADR-0031: per-turn
 * persistence makes a short poll read like live watching; SSE deliberately
 * deferred). 401s bubble to the shell so an expired token drops back to sign-in.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";

export function usePoll<T>(
  fetcher: () => Promise<T>,
  opts: { intervalMs: number; enabled?: boolean; onUnauthorized: () => void },
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // keep the latest callbacks without retriggering the effect
  const live = useRef({ fetcher, onUnauthorized: opts.onUnauthorized });
  live.current = { fetcher, onUnauthorized: opts.onUnauthorized };

  const enabled = opts.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const d = await live.current.fetcher();
        if (stop) return;
        setData(d);
        setError(null);
      } catch (e) {
        if (stop) return;
        if (e instanceof ApiError && e.status === 401) return live.current.onUnauthorized();
        setError(e instanceof Error ? e.message : String(e));
      }
      timer = setTimeout(tick, opts.intervalMs);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [enabled, opts.intervalMs]);

  return { data, error };
}
