// A fixture engine must not outlive the tmux-owned fixture that launched it.
process.on("disconnect", () => process.exit(0));
await import("../server/engine.js");
export {};
