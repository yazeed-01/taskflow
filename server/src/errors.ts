import { GraphQLError } from 'graphql';

// Expected failures (bad input, missing/forbidden resource) become *data* in the mutation's result
// union. Anything else — UNAUTHENTICATED, RATE_LIMITED, bugs — is rethrown and shows up in `errors`.
const ERROR_TYPE: Record<string, string> = {
  BAD_USER_INPUT: 'ValidationError',
  NOT_FOUND: 'NotFoundError',
  FORBIDDEN: 'ForbiddenError',
};

export function asResult<A extends unknown[], P extends object>(
  successType: string,
  fn: (...args: A) => Promise<P>,
) {
  return async (...args: A) => {
    try {
      return { __typename: successType, ...(await fn(...args)) };
    } catch (e) {
      if (e instanceof GraphQLError) {
        const typename = ERROR_TYPE[e.extensions?.code as string];
        if (typename) {
          const field = (e.extensions.field ?? e.extensions.argumentName ?? null) as string | null;
          return { __typename: typename, message: e.message, field };
        }
      }
      throw e;
    }
  };
}
