import { startupFailed } from "./process-ready.js";

const fixture = import(
  process.argv[2] === "mock" ? "./fixture-server.js" : "./real-server.js"
);
// Closing the parent's IPC channel also cleans up the nested inference process.
process.once("disconnect", async () => {
  try {
    await (await fixture).close();
  } finally {
    process.exit(0);
  }
});
await fixture.catch(startupFailed);
