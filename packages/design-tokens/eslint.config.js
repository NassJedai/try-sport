import base from '@try/eslint-config/base';

/**
 * The package is framework-neutral, so the shared config assumes no runtime
 * globals. `scripts/` is the exception: it runs under Node at build time.
 */
export default [
  ...base,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { URL: 'readonly', console: 'readonly', process: 'readonly' },
    },
  },
];
