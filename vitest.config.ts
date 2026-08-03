import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: { reporter: ['text', 'html'] },
    testTimeout: 15_000,
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
