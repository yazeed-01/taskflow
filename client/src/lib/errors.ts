/**
 * Expected failures come back as data: a mutation result is a union like
 * `CreateIssuePayload | ValidationError | NotFoundError | ForbiddenError`. Everything that implements
 * the schema's `UserError` interface has a `message`, so one helper handles all of them.
 * Returns the message when the result is an error, otherwise null.
 */
export function userError(result: { __typename?: string; message?: string } | null | undefined): string | null {
  if (!result) return 'No response from the server';
  if (result.__typename === 'ValidationError' || result.__typename === 'NotFoundError' || result.__typename === 'ForbiddenError') {
    return result.message ?? 'Something went wrong';
  }
  return null;
}

/** Unexpected failures (network down, server crash, rate limit) arrive as thrown errors. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
