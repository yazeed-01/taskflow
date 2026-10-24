import { ApolloClient, HttpLink, InMemoryCache, from, split } from '@apollo/client';
import { onError } from '@apollo/client/link/error';
import { setContext } from '@apollo/client/link/context';
import { createPersistedQueryLink } from '@apollo/client/link/persisted-queries';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { getMainDefinition, relayStylePagination } from '@apollo/client/utilities';
import { createClient } from 'graphql-ws';
import { clearToken, getToken } from './lib/auth';

const authLink = setContext((_, { headers }) => {
  const token = getToken();
  return { headers: { ...headers, ...(token && { authorization: `Bearer ${token}` }) } };
});

// An UNAUTHENTICATED error from anything except the login form itself means the token expired or is
// invalid: drop it and go to /login. (Expected errors — validation, forbidden — arrive as union data, not here.)
const errorLink = onError(({ graphQLErrors, operation }) => {
  const expired = graphQLErrors?.some((e) => e.extensions?.code === 'UNAUTHENTICATED');
  if (expired && operation.operationName !== 'Login' && operation.operationName !== 'SignUp') {
    clearToken();
    if (location.pathname !== '/login') location.assign('/login');
  }
});

// Automatic persisted queries: after the first request the client sends only a SHA-256 hash of the
// query, not its text — smaller requests, and the server can cache the parsed document.
const sha256 = async (query: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(query));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const httpLink = from([
  errorLink,
  authLink,
  createPersistedQueryLink({ sha256 }),
  new HttpLink({ uri: '/graphql' }),
]);

// Browsers can't set headers on a WebSocket, so the token goes in connectionParams.
// `lazy` opens the socket on the first subscription; the function form re-reads the token on every (re)connect.
const wsLink = new GraphQLWsLink(
  createClient({
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/graphql`,
    lazy: true,
    connectionParams: () => {
      const token = getToken();
      return token ? { authorization: `Bearer ${token}` } : {};
    },
    retryAttempts: Infinity,
    shouldRetry: () => true,
  }),
);

const link = split(
  ({ query }) => {
    const def = getMainDefinition(query);
    return def.kind === 'OperationDefinition' && def.operation === 'subscription';
  },
  wsLink,
  httpLink,
);

export const client = new ApolloClient({
  link,
  cache: new InMemoryCache({
    typePolicies: {
      // Normalization is automatic: every object with __typename + id is stored once under "Type:id",
      // so updating an Issue in a mutation, a subscription event, or the board refreshes it everywhere.
      // Connections need a policy telling the cache how to merge pages. keyArgs: pages of the *same*
      // filter/order are one list; a different filter is a different list.
      Project: { fields: { issues: relayStylePagination(['filter', 'orderBy']) } },
      Workspace: {
        fields: {
          issues: relayStylePagination(['filter', 'orderBy']),
          activity: relayStylePagination(),
        },
      },
      Query: { fields: { notifications: relayStylePagination(['unreadOnly']) } },
      Member: { keyFields: false }, // no id: embedded in its Workspace, not normalized
    },
  }),
});
