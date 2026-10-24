import { GraphQLError } from 'graphql';
import type { Role } from '@prisma/client';
import { prisma } from './db.js';
import type { NodeType } from './ids.js';

const RANK: Record<Role, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];

export const forbidden = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'FORBIDDEN' } });

export async function roleIn(userId: string, workspaceId: string): Promise<Role | null> {
  const m = await prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  return m?.role ?? null;
}

/**
 * Gate every workspace-scoped action through here.
 * - Not a member  -> NOT_FOUND (don't reveal that the resource exists).
 * - Member, but role too low -> FORBIDDEN.
 */
export async function authorize(userId: string, workspaceId: string, min: Role = 'MEMBER', what = 'Resource') {
  const role = await roleIn(userId, workspaceId);
  if (!role) throw new GraphQLError(`${what} not found`, { extensions: { code: 'NOT_FOUND' } });
  if (!atLeast(role, min)) throw forbidden(`Requires ${min.toLowerCase()} role`);
  return role;
}

/** Which workspace does an object live in? Used by `node(id)` and by queries that take a bare ID. */
export async function workspaceIdOf(type: NodeType, id: string): Promise<string | null> {
  switch (type) {
    case 'Workspace':
      return id;
    case 'Project':
      return (await prisma.project.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null;
    case 'Label':
      return (await prisma.label.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null;
    case 'Issue':
      return (await prisma.issue.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null;
    case 'Comment':
      return (
        (
          await prisma.comment.findUnique({
            where: { id },
            select: { issue: { select: { project: { select: { workspaceId: true } } } } },
          })
        )?.issue.project.workspaceId ?? null
      );
    case 'Activity':
      return (await prisma.activity.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null;
    case 'User':
    case 'Notification':
      return null; // not workspace-scoped; handled separately
  }
}
