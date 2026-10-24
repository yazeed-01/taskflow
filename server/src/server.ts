import { ApolloServer, type ApolloServerPlugin } from '@apollo/server';
import type { ValidationRule } from 'graphql';
import type { Context } from './context.js';
import { schema } from './schema.js';
import { complexityPlugin, depthLimit, MAX_DEPTH } from './security.js';

const isProd = process.env.NODE_ENV === 'production';

export const createServer = (opts: { plugins?: ApolloServerPlugin<Context>[]; production?: boolean } = {}) => {
  const prod = opts.production ?? isProd;
  return new ApolloServer<Context>({
    schema,
    validationRules: [depthLimit(MAX_DEPTH) as unknown as ValidationRule],
    plugins: [complexityPlugin(), ...(opts.plugins ?? [])],
    // Introspection lets anyone download your whole schema. Fine in dev (tooling needs it); off in prod.
    introspection: !prod,
    includeStacktraceInErrorResponses: !prod,
    formatError: (formatted, error) => {
      // Unexpected failures (DB down, bugs) must not leak internals to clients; log the real thing.
      if (prod && formatted.extensions?.code === 'INTERNAL_SERVER_ERROR') {
        console.error(error);
        return { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } };
      }
      return formatted;
    },
  });
};
