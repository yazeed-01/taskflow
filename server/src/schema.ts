import { readFileSync } from 'node:fs';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { resolvers } from './resolvers.js';
import { subscriptionResolvers } from './subscriptions.js';

export const typeDefs = readFileSync(new URL('./schema.graphql', import.meta.url), 'utf8');

// One executable schema, shared by the HTTP endpoint (queries/mutations) and the WebSocket endpoint
// (subscriptions).
export const schema = makeExecutableSchema({
  typeDefs,
  resolvers: { ...resolvers, ...subscriptionResolvers } as any,
});
