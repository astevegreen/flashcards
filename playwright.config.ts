import { defineConfig, devices } from '@playwright/test';

/**
 * Phase 13 adaptive-layout device matrix. Only `layout-study.spec.ts` (the core study flow under
 * every viewport) runs on these; every other spec stays on Desktop Chrome so the suite stays fast.
 */
const LAYOUT_SPEC = /layout-study\.spec\.ts$/;

const phone = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } as const;

const DEVICE_PROJECTS: readonly {
  name: string;
  viewport: { width: number; height: number };
  touch: boolean;
}[] = [
  { name: 'small-phone-320x568', viewport: { width: 320, height: 568 }, touch: true },
  { name: 'phone-390x844', viewport: { width: 390, height: 844 }, touch: true },
  { name: 'phone-landscape-844x390', viewport: { width: 844, height: 390 }, touch: true },
  { name: 'fold-cover-344x882', viewport: { width: 344, height: 882 }, touch: true },
  { name: 'tablet-portrait-820x1180', viewport: { width: 820, height: 1180 }, touch: true },
  { name: 'tablet-landscape-1180x820', viewport: { width: 1180, height: 820 }, touch: true },
  { name: 'desktop-1920x1080', viewport: { width: 1920, height: 1080 }, touch: false },
];

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  // Several specs drive two pages plus replay Web Workers each; at Playwright's default
  // (half the logical cores) they starve each other locally and time out. 4 keeps runs stable.
  workers: process.env['CI'] ? 1 : 4,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    ...DEVICE_PROJECTS.map(({ name, viewport, touch }) => ({
      name,
      testMatch: LAYOUT_SPEC,
      use: {
        ...devices['Desktop Chrome'],
        viewport,
        ...(touch ? phone : {}),
      },
    })),
  ],
  webServer: {
    command: 'pnpm --filter @flash/web preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
});
