export function startNudgeWorker({ runNudges, intervalMs = 60000 }) {
  let running = null;
  let stopping = false;

  function tick() {
    if (stopping) return Promise.resolve();
    if (running) return running;
    running = Promise.resolve()
      .then(() => runNudges())
      .catch(() => {
        // Provider errors can contain credentials; never log the exception.
        console.error(
          "The follow-up check could not finish. Review the app and database availability.",
        );
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  const firstCheck = tick();
  const timer = setInterval(
    () => void tick(),
    Math.max(1000, Number(intervalMs) || 60000),
  );
  timer.unref();

  return {
    firstCheck,
    tick,
    async stop() {
      stopping = true;
      clearInterval(timer);
      await running;
    },
  };
}
