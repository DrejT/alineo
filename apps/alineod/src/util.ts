/** Small helpers shared by the engine and the route modules. */

/**
 * Race a promise against a timeout, returning `undefined` instead of hanging or throwing.
 * For best-effort live-agent calls (`getState()`, `getSessionStats()`, …) where a paused or
 * unresponsive bridge would otherwise leave the caller waiting forever.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]).catch(() => undefined);
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
