import { defaultExclude, defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import react from '@vitejs/plugin-react'
import path from 'path'

/** The vite pipeline a spec needs to load app code: JSX transform and `@` alias. */
const appPipeline = {
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
}

/** Applies to both projects: vitest's globals, and where the matchers come from. */
const shared = {
  globals: true,
  setupFiles: ['./src/test/setup.ts'],
}

// Two projects, deliberately separated by test-file name:
//
//   unit    — `*.test.ts(x)` under jsdom. The default suite; no browser binaries.
//   browser — `*.browser.test.ts(x)` in headless chromium. jsdom has no layout
//             engine, so anything that measures an element can only be tested
//             there. Kept small on purpose: it needs playwright's chromium
//             download, which CI installs for that job alone.
export default defineConfig({
  test: {
    projects: [
      {
        ...appPipeline,
        test: {
          ...shared,
          name: 'unit',
          environment: 'jsdom',
          exclude: [...defaultExclude, '**/*.browser.test.{ts,tsx}'],
        },
      },
      {
        ...appPipeline,
        test: {
          ...shared,
          name: 'browser',
          include: ['src/**/*.browser.test.{ts,tsx}'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
