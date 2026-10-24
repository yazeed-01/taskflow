import type { IncomingMessage } from 'node:http';
import type { User } from '@prisma/client';
import { GraphQLError } from 'graphql';
import { prisma } from './db.js';
import { verifyToken } from './auth.js';
import { createLoaders, type Loaders } from './loaders.js';

export interface Context {
  user: User | null;
  loaders: Loaders;
}

// Authorization: Bearer <jwt>. A missing/invalid token just means "anonymous";
// each resolver decides whether that's allowed (requireUser).
export async function buildContextFromHeader(header: string | undefined): Promise<Context> {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = token ? verifyToken(token) : null;
  const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  return { user, loaders: createLoaders(user) }; // fresh loaders per request: no cross-user cache leaks
}

export const buildContext = (req: IncomingMessage) => buildContextFromHeader(req.headers.authorization);

export function requireUser(ctx: Context): User {
  if (!ctx.user) {
    throw new GraphQLError('You must be signed in', { extensions: { code: 'UNAUTHENTICATED' } });
  }
  return ctx.user;
}
