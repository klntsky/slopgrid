// Do not leave a runtime behind when its launcher disappears.
process.on("disconnect", () => process.kill(process.pid, "SIGTERM"));
await import(process.argv[2]);
export {};
