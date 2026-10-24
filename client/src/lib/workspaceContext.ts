import { createContext, useContext } from 'react';
import type { WorkspaceShellQuery } from '../gql/graphql';

export type ShellWorkspace = NonNullable<WorkspaceShellQuery['workspace']>;
export type ShellMe = NonNullable<WorkspaceShellQuery['me']>;

export interface WorkspaceCtx {
  workspace: ShellWorkspace;
  me: ShellMe;
  isAdmin: boolean;
  openIssue: (id: string) => void;
}

export const WorkspaceContext = createContext<WorkspaceCtx | null>(null);

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceLayout>');
  return ctx;
}
