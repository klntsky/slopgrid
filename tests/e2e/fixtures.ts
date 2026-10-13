import { test as base, expect } from "@playwright/test";
import { startTestServer } from "../test-server";

export const test = base.extend<{}, { mockServer: string }>({
  mockServer: [
    async ({}, use) => {
      const server = await startTestServer("mock");
      try {
        await use(server.origin);
      } finally {
        server.close();
      }
    },
    { scope: "worker", timeout: 45000 },
  ],
  baseURL: async ({ mockServer }, use) => {
    await use(mockServer);
  },
});
export { expect };
