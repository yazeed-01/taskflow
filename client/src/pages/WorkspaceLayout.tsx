import { useMemo, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { graphql } from '../gql';
import { clearToken } from '../lib/auth';
import { errorText, userError } from '../lib/errors';
import { WorkspaceContext } from '../lib/workspaceContext';
import { IssueModal } from '../components/IssueModal';
import { NotificationBell } from '../components/NotificationBell';
import { useToast } from '../components/Toasts';

export const WORKSPACE_SHELL = graphql(`
  query WorkspaceShell($slug: String!) {
    me {
      id
      name
      email
    }
    workspaces {
      id
      name
      slug
    }
    workspace(slug: $slug) {
      id
      name
      slug
      viewerRole
      projects {
        id
        name
        key
      }
      members {
        role
        user {
          id
          name
          email
        }
      }
      labels {
        id
        name
        color
      }
    }
  }
`);

const CREATE_PROJECT = graphql(`
  mutation CreateProject($input: CreateProjectInput!) {
    createProject(input: $input) {
      __typename
      ... on CreateProjectPayload {
        project {
          id
          name
          key
        }
      }
      ... on UserError {
        message
      }
    }
  }
`);

export function WorkspaceLayout() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { data, loading, error } = useQuery(WORKSPACE_SHELL, { variables: { slug } });
  const [createProject] = useMutation(CREATE_PROJECT, {
    refetchQueries: [{ query: WORKSPACE_SHELL, variables: { slug } }],
  });
  const [adding, setAdding] = useState(false);
  const [pName, setPName] = useState('');
  const [pKey, setPKey] = useState('');

  const openIssue = (id: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('issue', id);
      return next;
    });
  const closeIssue = () =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete('issue');
      return next;
    });

  const ctx = useMemo(
    () =>
      data?.workspace && data.me
        ? {
            workspace: data.workspace,
            me: data.me,
            isAdmin: data.workspace.viewerRole !== 'MEMBER',
            openIssue,
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data],
  );

  if (loading) return <div className="center">Loading…</div>;
  if (error) return <div className="center form-error">{error.message}</div>;
  if (!ctx || !data) {
    // Not a member (or no such workspace) look identical on purpose: the API never confirms existence.
    return (
      <div className="center">
        <h2>Workspace not found</h2>
        <button className="btn" onClick={() => navigate('/')}>Go home</button>
      </div>
    );
  }

  const { workspace, me } = ctx;
  const issueId = params.get('issue');

  async function addProject(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await createProject({ variables: { input: { workspaceId: workspace.id, name: pName, key: pKey } } });
      const msg = userError(res.data?.createProject);
      if (msg) return toast(msg, 'error');
      const created = res.data?.createProject;
      setAdding(false);
      setPName('');
      setPKey('');
      if (created?.__typename === 'CreateProjectPayload') navigate(`/w/${slug}/p/${created.project.id}`);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  return (
    <WorkspaceContext.Provider value={ctx}>
      <div className="shell">
        <aside className="sidebar">
          <div className="logo">
            <span className="logo-mark">✓</span> TaskFlow
          </div>
          <select
            className="ws-switch"
            value={slug}
            onChange={(e) => navigate(`/w/${e.target.value}`)}
            aria-label="Switch workspace"
          >
            {data.workspaces.map((w) => (
              <option key={w.id} value={w.slug}>{w.name}</option>
            ))}
          </select>

          <nav>
            <div className="nav-title">Projects</div>
            {workspace.projects.map((p) => (
              <NavLink key={p.id} to={`/w/${slug}/p/${p.id}`} className="nav-item">
                <span className="key">{p.key}</span> {p.name}
              </NavLink>
            ))}
            {ctx.isAdmin &&
              (adding ? (
                <form className="mini-form" onSubmit={addProject}>
                  <input placeholder="Name" value={pName} onChange={(e) => setPName(e.target.value)} required autoFocus />
                  <input placeholder="KEY" value={pKey} onChange={(e) => setPKey(e.target.value.toUpperCase())} required maxLength={5} minLength={2} />
                  <div className="row">
                    <button className="btn btn-primary btn-sm">Create</button>
                    <button type="button" className="btn btn-sm" onClick={() => setAdding(false)}>Cancel</button>
                  </div>
                </form>
              ) : (
                <button className="nav-item nav-add" onClick={() => setAdding(true)}>+ New project</button>
              ))}

            <div className="nav-title">Workspace</div>
            <NavLink to={`/w/${slug}/search`} className="nav-item">🔍 Search</NavLink>
            <NavLink to={`/w/${slug}/activity`} className="nav-item">⚡ Activity</NavLink>
            <NavLink to={`/w/${slug}/members`} className="nav-item">👥 Members</NavLink>
          </nav>
        </aside>

        <div className="main-col">
          <header className="topbar">
            <span className="muted">{workspace.name} · you are {workspace.viewerRole.toLowerCase()}</span>
            <div className="row">
              <NotificationBell onOpenIssue={openIssue} />
              <span className="avatar" title={me.email ?? me.name}>{me.name.slice(0, 2).toUpperCase()}</span>
              <button className="link" onClick={() => { clearToken(); location.assign('/login'); }}>Sign out</button>
            </div>
          </header>
          <main className="content">
            <Outlet />
          </main>
        </div>
      </div>
      {issueId && <IssueModal issueId={issueId} onClose={closeIssue} />}
    </WorkspaceContext.Provider>
  );
}
