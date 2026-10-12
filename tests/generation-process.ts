// A fixture engine must not outlive the tmux-owned fixture that launched it.
process.on("disconnect", () => process.exit(0));
// Only fixture children expose an inspector, and only when a crash test asks.
process.on("message", async (message) => {
  if ((message as { inspect?: boolean }).inspect) {
    const inspector = await import("node:inspector");
    inspector.open(0, "127.0.0.1");
    process.send?.(inspector.url());
  }
});
await import("../server/engine.js");
export {};
