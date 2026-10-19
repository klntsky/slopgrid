import { test as base, expect } from "@playwright/test";
import { startTestServer } from "../test-server";

type WorkerServer = { origin: string; prepare: () => Promise<void> };

export const test = base.extend<
  { mockServer: string },
  { workerServer: WorkerServer }
>({
  workerServer: [
    async ({}, use) => {
      const server = await startTestServer("mock");
      try {
        let used = false;
        await use({
          origin: server.origin,
          prepare: async () => {
            if (used) await server.reset();
            used = true;
          },
        });
      } finally {
        await server.close();
      }
    },
    { scope: "worker", timeout: 45000 },
  ],
  mockServer: async ({ workerServer }, use) => {
    await workerServer.prepare();
    await use(workerServer.origin);
  },
  baseURL: async ({ mockServer }, use) => {
    await use(mockServer);
  },
});
export { expect };
