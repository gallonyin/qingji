/** Schedule after completion so slow requests never overlap. Hidden/offline tabs stay idle. */
export function startVisiblePolling(poll: () => Promise<number>) {
  let stopped = false, running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const available = () => !document.hidden && navigator.onLine;
  const run = async () => {
    clearTimeout(timer);
    if (stopped || running || !available()) return;
    running = true;
    let delay = 60000;
    try { delay = await poll(); } catch { /* Retry transient failures at the idle interval. */ }
    finally {
      running = false;
      if (!stopped && available()) timer = setTimeout(run, delay);
    }
  };
  const wake = () => { clearTimeout(timer); void run(); };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  window.addEventListener('offline', wake);
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('online', wake);
    window.removeEventListener('offline', wake);
  };
}
