import { signalReady, startupFailed } from "./process-ready.js";
// A fixture engine must not outlive the parent process that launched it.
process.on("disconnect", () => process.exit(0));
// Only fixture children expose an inspector, and only when a crash test asks.
process.on("message", async (message) => {
  if ((message as { inspect?: boolean }).inspect) {
    const inspector = await import("node:inspector");
    inspector.open(0, "127.0.0.1");
    process.send?.(inspector.url());
  }
});
try {
  await import("./request-preparation-fixture.js");
  if (process.env.FIXTURE_IGNORE_ABORT === "1") {
    // Model a provider call that outlives cancellation while retaining the real
    // adapter, SDK, stream parser, and billing recorder. The upstream test owns
    // settlement; production never imports this fixture entrypoint.
    const { Provider } = await import("../server/provider.js");
    const generate = Provider.prototype.generate;
    Provider.prototype.generate = function (...args) {
      args[4] = undefined;
      return generate.apply(this, args);
    };
  }
  await import("../server/engine.js");
  signalReady();
} catch (error) {
  startupFailed(error);
}
export {};
