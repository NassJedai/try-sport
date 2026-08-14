import base from './base.js';

export default [
  ...base,
  {
    rules: {
      /**
       * The injected-Clock rule exists to keep *domain* logic testable, and it
       * stays on for the API and the shared packages. In UI code "now" is a
       * rendering concern — the default range on a dashboard, a relative
       * timestamp — and there is no domain decision to make deterministic.
       */
      'no-restricted-syntax': 'off',
    },
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
        __DEV__: 'readonly',
      },
    },
  },
];
