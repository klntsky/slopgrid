import { defineConfig } from "@playwright/test";
import { availableParallelism } from "node:os";
export default defineConfig({
  fullyParallel: false,
  workers: process.env.E2E_WORKERS
    ? Number(process.env.E2E_WORKERS)
    : Math.min(4, availableParallelism()),
  use: {
    baseURL: process.env.E2E_ORIGIN ?? "http://localhost:4317",
    browserName: "chromium",
    ignoreHTTPSErrors: true,
  },
  reporter: "list",
  timeout: 30000,
  projects: [
    {
      name: "github",
      testDir: "tests/github-e2e",
      timeout: 420000,
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    { name: "mock", testDir: "tests/e2e", fullyParallel: true },
    {
      name: "real",
      testDir: "tests/real-e2e",
      timeout: 90000,
      use: { trace: "off", screenshot: "off", video: "off" },
    },
  ],
});
