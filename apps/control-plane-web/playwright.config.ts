import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["web-chat.spec.ts", "web-auth.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  outputDir: "output/playwright/test-results",
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4174",
    colorScheme: "light",
    locale: "zh-CN",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run build && node --import tsx tests/fixtures/fake-web-server.ts",
      url: "http://127.0.0.1:4174/client/v1/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node --import tsx tests/fixtures/fake-auth-web-server.ts",
      url: "http://127.0.0.1:4175/client/v1/config",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    { name: "desktop", testMatch: "web-chat.spec.ts", use: { viewport: { width: 1_440, height: 960 } } },
    { name: "compact", testMatch: "web-chat.spec.ts", use: { viewport: { width: 1_024, height: 820 } } },
    { name: "iphone", testMatch: "web-chat.spec.ts", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: "auth-desktop", testMatch: "web-auth.spec.ts", use: { baseURL: "http://127.0.0.1:4175", viewport: { width: 1_440, height: 960 } } },
    { name: "auth-compact", testMatch: "web-auth.spec.ts", use: { baseURL: "http://127.0.0.1:4175", viewport: { width: 1_024, height: 820 } } },
    { name: "auth-iphone", testMatch: "web-auth.spec.ts", use: { baseURL: "http://127.0.0.1:4175", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
