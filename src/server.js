import "dotenv/config";
import { createApp } from "./app.js";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const interval = Math.max(1000, Number(process.env.NUDGE_INTERVAL_MS) || 60000);
const suite = createApp();
let running = false;
let stopping = false;
async function tick() {
  if (running || stopping) return;
  running = true;
  try {
    await suite.runNudges();
  } catch {
    console.error(
      "The follow-up check could not finish. Review the app and database availability.",
    );
  } finally {
    running = false;
  }
}
const server = suite.app.listen(port, host, () => {
  console.log(`Trades Suite is running at http://${host}:${port}`);
  console.log(
    `Text mode: ${process.env.SMS_MODE === "twilio" ? "Twilio (live)" : "Demo (no texts sent)"}`,
  );
  void tick();
});
const timer = setInterval(() => void tick(), interval);
timer.unref();
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.close(async () => {
    while (running) await new Promise((resolve) => setTimeout(resolve, 50));
    suite.close();
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
