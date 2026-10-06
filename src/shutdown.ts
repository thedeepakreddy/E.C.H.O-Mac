/** Continue releasing other resources even when one service ignores shutdown. */
export async function shutdownStep(name: string, stop: () => unknown, timeoutMs = 8000, report: (message: string) => void = console.error): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(stop),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`exceeded ${timeoutMs}ms`)), timeoutMs); }),
    ]);
    return true;
  } catch (error) {
    report(`[shutdown] ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally { if (timer) clearTimeout(timer); }
}

/** All quit entry points share one cleanup and one exit, including repeated signals. */
export function gracefulShutdown(cleanup: () => Promise<void>, exit: () => void, report: (message: string) => void = console.log): (source: string) => Promise<void> {
  let pending: Promise<void> | undefined;
  return (source) => {
    if (!pending) {
      report(`[jarvis] graceful shutdown requested by ${source}`);
      pending = Promise.resolve().then(cleanup).catch(error => {
        report(`[shutdown] cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }).then(() => {
        report('[jarvis] shutdown cleanup complete');
        exit();
      });
    }
    return pending;
  };
}
