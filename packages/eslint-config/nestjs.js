import base from './base.js';

export default [
  ...base,
  {
    rules: {
      // Nest expresses DI through decorator metadata on empty constructors/classes.
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
];
