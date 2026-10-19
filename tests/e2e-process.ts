import { startupFailed } from "./process-ready.js";

const fixture = import(
  process.argv[2] === "mock" ? "./fixture-server.js" : "./real-server.js"
);
process.on("message", async (message: { type?: string; id?: number }) => {
  if (message.type !== "reset") return;
  try {
    const loaded = await fixture;
    if (!("reset" in loaded))
      throw new Error("Only mock fixtures can be reset");
    const state = await loaded.reset();
    process.send?.({ type: "reset", id: message.id, state });
  } catch (error) {
    process.send?.({ type: "reset", id: message.id, error: String(error) });
  }
});
// Closing the parent's IPC channel also cleans up the nested inference process.
process.once("disconnect", async () => {
  try {
    await (await fixture).close();
  } finally {
    process.exit(0);
  }
});
await fixture.catch(startupFailed);
