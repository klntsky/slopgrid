// Process supervision and debugger access only; application code is unmodified.
process.on("disconnect", () => process.exit(0));
process.on("message", async (message) => {
  if ((message as { inspect?: boolean }).inspect) {
    const inspector = await import("node:inspector");
    inspector.open(0, "127.0.0.1");
    process.send?.(inspector.url());
  }
});
await import(process.env.FIXTURE_ENTRY!);
export {};
