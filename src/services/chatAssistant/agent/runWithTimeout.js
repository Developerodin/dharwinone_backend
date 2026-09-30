export const TOOL_TIMEOUT = 'TOOL_TIMEOUT';

/** Runs `fn`, rejecting with an error whose `code` is TOOL_TIMEOUT once `timeoutMs` elapses (<= 0 = no limit). */
export async function runWithTimeout(fn, timeoutMs) {
  if (!(timeoutMs > 0)) return fn();
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`tool timed out after ${timeoutMs}ms`);
          err.code = TOOL_TIMEOUT;
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
