import { GraphQLError } from 'graphql';

// Relay convention: the public ID encodes the type, so `node(id)` can route to the right table.
export type NodeType = 'User' | 'Workspace' | 'Project' | 'Issue' | 'Comment' | 'Label' | 'Activity' | 'Notification';

export const toGlobalId = (type: NodeType, id: string) =>
  Buffer.from(`${type}:${id}`).toString('base64url');

export function fromGlobalId(globalId: string, expected?: NodeType): { type: NodeType; id: string } {
  const decoded = Buffer.from(globalId, 'base64url').toString('utf8');
  const sep = decoded.indexOf(':');
  const type = decoded.slice(0, sep) as NodeType;
  const id = decoded.slice(sep + 1);
  if (sep < 1 || !id || (expected && type !== expected)) {
    throw new GraphQLError(`Invalid ${expected ?? 'object'} ID`, {
      extensions: { code: 'BAD_USER_INPUT', argumentName: 'id' },
    });
  }
  return { type, id };
}

/** Decode an ID that must be of a given type and return the raw DB id. */
export const dbId = (globalId: string, type: NodeType) => fromGlobalId(globalId, type).id;
