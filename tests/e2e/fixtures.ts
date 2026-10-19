import { test as base, expect } from "@playwright/test";
import { startTestServer } from "../test-server";
import { parseE2EPort } from "../e2e-port";

const port = parseE2EPort(process.env.E2E_PORT);

export const test = base.extend<{ mockServer: string }>({
  mockServer: [
    async ({}, use) => {
      const server = await startTestServer("mock", port);
      try {
        await use(server.origin);
      } finally {
        await server.close();
      }
    },
    { timeout: 45000 },
  ],
  baseURL: async ({ mockServer }, use) => {
    await use(mockServer);
  },
});
export { expect };
