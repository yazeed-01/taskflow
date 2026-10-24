import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation } from '@apollo/client';
import { graphql } from '../gql';
import type { Role } from '../gql/graphql';
import { initials } from '../components/IssueCard';
import { useToast } from '../components/Toasts';
import { useWorkspace } from '../lib/workspaceContext';
import { errorText, userError } from '../lib/errors';
import { WORKSPACE_SHELL } from './WorkspaceLayout';

const ADD_MEMBER = graphql(`
  mutation AddMember($input: AddMemberInput!) {
    addMember(input: $input) {
      __typename
      ... on AddMemberPayload {
        member {
          role
          user {
            id
            name
          }
        }
      }
      ... on UserError {
        message
      }
    }
  }
`);

const UPDATE_ROLE = graphql(`
  mutation UpdateMemberRole($input: UpdateMemberRoleInput!) {
    updateMemberRole(input: $input) {
      __typename
      ... on UpdateMemberRolePayload {
        member {
          role
          user {
            id
          }
        }
      }
      ... on UserError {
        message
      }
    }
  }
`);

const REMOVE_MEMBER = graphql(`
  mutation RemoveMember($input: RemoveMemberInput!) {
    removeMember(input: $input) {
      __typename
      ... on RemoveMemberPayload {
        removedUserId
      }
      ... on UserError {
        message
      }
    }
  }
`);

const ROLES: Role[] = ['MEMBER', 'ADMIN', 'OWNER'];

export function MembersPage() {
  const { slug = '' } = useParams();
  const { workspace, me, isAdmin } = useWorkspace();
  const toast = useToast();
  const refetch = { refetchQueries: [{ query: WORKSPACE_SHELL, variables: { slug } }] };
  const [addMember] = useMutation(ADD_MEMBER, refetch);
  const [updateRole] = useMutation(UPDATE_ROLE, refetch);
  const [removeMember] = useMutation(REMOVE_MEMBER, refetch);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('MEMBER');
  const isOwner = workspace.viewerRole === 'OWNER';

  // The server is the authority on who may do what; the UI only hides what would be refused anyway
  // and surfaces the server's ForbiddenError / ValidationError message when it does refuse.
  async function run<T extends { __typename?: string; message?: string } | null | undefined>(p: Promise<T>) {
    try {
      const msg = userError(await p);
      if (msg) toast(msg, 'error');
      return !msg;
    } catch (e) {
      toast(errorText(e), 'error');
      return false;
    }
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    const ok = await run(
      addMember({ variables: { input: { workspaceId: workspace.id, email, role } } }).then((r) => r.data?.addMember),
    );
    if (ok) setEmail('');
  }

  return (
    <div>
      <div className="page-head">
        <h1>Members</h1>
      </div>
      <ul className="members">
        {workspace.members.map((m) => (
          <li key={m.user.id}>
            <span className="avatar">{initials(m.user.name)}</span>
            <div className="grow">
              <strong>{m.user.name}</strong> {m.user.id === me.id && <span className="muted">(you)</span>}
              <div className="muted small">{m.user.email}</div>
            </div>
            {isAdmin ? (
              <select
                value={m.role}
                aria-label={`Role of ${m.user.name}`}
                onChange={(e) =>
                  run(updateRole({ variables: { input: { workspaceId: workspace.id, userId: m.user.id, role: e.target.value as Role } } }).then((r) => r.data?.updateMemberRole))
                }
              >
                {ROLES.filter((r) => r !== 'OWNER' || isOwner || m.role === 'OWNER').map((r) => (
                  <option key={r} value={r}>{r.toLowerCase()}</option>
                ))}
              </select>
            ) : (
              <span className="status-pill">{m.role.toLowerCase()}</span>
            )}
            {(isAdmin || m.user.id === me.id) && (
              <button
                className="btn btn-sm btn-danger"
                onClick={() => {
                  if (confirm(m.user.id === me.id ? 'Leave this workspace?' : `Remove ${m.user.name}?`)) {
                    void run(removeMember({ variables: { input: { workspaceId: workspace.id, userId: m.user.id } } }).then((r) => r.data?.removeMember));
                  }
                }}
              >
                {m.user.id === me.id ? 'Leave' : 'Remove'}
              </button>
            )}
          </li>
        ))}
      </ul>

      {isAdmin && (
        <form className="add-member" onSubmit={onAdd}>
          <h3>Add a member</h3>
          <div className="row">
            <input type="email" placeholder="Email of an existing user" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
              {ROLES.filter((r) => r !== 'OWNER' || isOwner).map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}
            </select>
            <button className="btn btn-primary">Add</button>
          </div>
        </form>
      )}
    </div>
  );
}
