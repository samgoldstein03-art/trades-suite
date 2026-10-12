import "dotenv/config";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { createApp } from "../src/app.js";

// A separate, explicitly simulated workspace. This cannot send a real text.
const suite = createApp({
  dbPath: process.env.DEMO_DATABASE_PATH || "data/demo.sqlite",
  smsMode: "demo",
});
const server = suite.app.listen(Number(process.env.PORT || 3000), "127.0.0.1");
try {
  await once(server, "listening");
} catch (error) {
  suite.close();
  console.error(error.code === "EADDRINUSE"
    ? `Port ${process.env.PORT || 3000} is already in use. Close the other Tradesuite window, then try again.`
    : "The demo could not start. Check that its data folder is writable and the chosen port is available.");
  process.exit(1);
}
const url = `http://127.0.0.1:${server.address().port}`;
process.env.APP_URL = url;
if (!suite.db.prepare("SELECT 1 FROM businesses LIMIT 1").get())
  await import("./seed-demo.js");
console.log(`Tradesuite demo is ready at ${url}`);
console.log("Demo only. No real texts are sent. Press Ctrl+C to stop.");
if (process.argv.includes("--open") && process.platform === "win32") {
  execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true }, (error) => {
    if (error) console.log(`Open ${url} in your browser to continue.`);
  });
}
let checking = false;
const timer = setInterval(async () => {
  if (checking) return;
  checking = true;
  try {
    await suite.runNudges();
  } catch {
    console.error("Demo follow-up check could not finish.");
  } finally {
    checking = false;
  }
}, 60000);
function stop() {
  clearInterval(timer);
  server.close(async () => {
    while (checking) await new Promise((resolve) => setTimeout(resolve, 20));
    suite.close();
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
