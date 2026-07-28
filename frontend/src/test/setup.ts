// Registered as `setupFiles` for both the jsdom and the browser project.
//
// `@testing-library/jest-dom/vitest` adds the DOM matchers (`toBeInTheDocument`,
// `toHaveAttribute`, `toHaveStyle`, …) to vitest's `expect` and augments its
// types, so specs assert on what the DOM says rather than on null-ness.
import '@testing-library/jest-dom/vitest'
