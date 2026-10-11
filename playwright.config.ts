import { defineConfig } from "@playwright/test";
export default defineConfig({
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://localhost:4317", browserName: "chromium" },
  reporter: "list",
  timeout: 30000,
  projects: [
    { name: "mock", testDir: "tests/e2e" },
    {
      name: "real",
      testDir: "tests/real-e2e",
      timeout: 90000,
      use: { trace: "off", screenshot: "off", video: "off" },
    },
  ],
});
