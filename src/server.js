import "dotenv/config";
import { createApp } from "./app.js";
import { startNudgeWorker } from "./worker.js";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const interval = Math.max(1000, Number(process.env.NUDGE_INTERVAL_MS) || 60000);
const suite = createApp();
let worker;
let stopping = false;
const server = suite.app.listen(port, host, () => {
  console.log(`Trades Suite is running at http://${host}:${port}`);
  console.log(
    `Text mode: ${process.env.SMS_MODE === "twilio" ? "Twilio (live)" : "Demo (no texts sent)"}`,
  );
  if (!stopping)
    worker = startNudgeWorker({ runNudges: suite.runNudges, intervalMs: interval });
});
function stop() {
  if (stopping) return;
  stopping = true;
  const workerStopped = worker?.stop();
  server.close(async () => {
    await workerStopped;
    suite.close();
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
