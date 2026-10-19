// Process supervision, listener discovery and debugger access only.
import { once } from "node:events";
import type { Server } from "node:http";

process.on("disconnect", () => process.exit(0));
process.on("message", async (message) => {
  if ((message as { inspect?: boolean }).inspect) {
    const inspector = await import("node:inspector");
    inspector.open(0, "127.0.0.1");
    process.send?.(inspector.url());
  }
});
const entry = await import(process.env.FIXTURE_ENTRY!);
const server = entry.server as Server | undefined;
if (server) {
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (address && typeof address === "object")
    process.send?.({ type: "ready", port: address.port });
}
export {};
