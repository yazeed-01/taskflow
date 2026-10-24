import type { CodegenConfig } from '@graphql-codegen/cli';

// The server's schema.graphql is the single source of truth. Every query/fragment/mutation string in
// src/**/*.tsx is checked against it at codegen time and turned into a TypedDocumentNode, so a typo in
// a field name, or a client that is out of step with the schema, fails the build instead of production.
const config: CodegenConfig = {
  schema: '../server/src/schema.graphql',
  documents: ['src/**/*.{ts,tsx}', '!src/gql/**/*'],
  ignoreNoDocuments: true,
  generates: {
    './src/gql/': {
      preset: 'client',
      // Plain function, not a React hook — named accordingly so nobody calls it a hook rule violation.
      presetConfig: { fragmentMasking: { unmaskFunctionName: 'getFragmentData' } },
      config: {
        useTypeImports: true,
        enumsAsTypes: true,
        scalars: { DateTime: 'string' },
      },
    },
  },
};

export default config;
