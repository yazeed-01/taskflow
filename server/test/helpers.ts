import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { createServer } from '../src/server.js';
import { buildContext } from '../src/context.js';
import { queryStats } from '../src/db.js';

export const server = createServer();

export async function run(query: string, variables: Record<string, unknown> = {}, token?: string) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} } as IncomingMessage;
  const contextValue = await buildContext(req);
  queryStats.count = 0;
  const res = await server.executeOperation({ query, variables }, { contextValue });
  assert.equal(res.body.kind, 'single');
  const { data, errors } = (res.body as any).singleResult;
  return {
    data,
    errors,
    code: errors?.[0]?.extensions?.code as string | undefined,
    queries: queryStats.count,
  };
}

/**
 * Run a mutation that returns a result union. `ok` is the selection inside the success payload,
 * e.g. `issue { id }`. Returns the concrete type name, so tests can assert on ValidationError /
 * NotFoundError / ForbiddenError as plain data.
 */
export async function mutate(
  name: string,
  inputType: string,
  payloadType: string,
  ok: string,
  input: Record<string, unknown>,
  token?: string,
) {
  const r = await run(
    `mutation($i: ${inputType}!){ ${name}(input:$i){ __typename ... on ${payloadType}{ ${ok} } ... on UserError { message } ... on ValidationError { field } } }`,
    { i: input },
    token,
  );
  const result = r.data?.[name];
  return { ...r, type: result?.__typename as string | undefined, result };
}

export const login = async (email: string, password = 'password123') => {
  const r = await run(`mutation($i: LoginInput!){ login(input:$i){ token user { id } } }`, { i: { email, password } });
  return r.data.login.token as string;
};

export const signUp = async (name: string, email: string, password = 'longenough1') => {
  const r = await run(`mutation($i: SignUpInput!){ signUp(input:$i){ token user { id } } }`, { i: { name, email, password } });
  return { token: r.data.signUp.token as string, id: r.data.signUp.user.id as string };
};
