import base from './base.js';

export default [
  ...base,
  {
    rules: {
      // Nest expresses DI through decorator metadata on empty constructors/classes.
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',

      /**
       * Deliberately disabled for the API, and it must stay that way.
       *
       * NestJS resolves constructor dependencies from the type metadata emitted by
       * `emitDecoratorMetadata`, which requires the class to be a *runtime* import.
       * `consistent-type-imports` autofixes `import { FooService }` into
       * `import type { FooService }`, the metadata degrades to `Object`, and the
       * application fails to boot with an unresolved-dependency error at runtime —
       * a failure that typecheck and build both report as clean.
       */
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
];
