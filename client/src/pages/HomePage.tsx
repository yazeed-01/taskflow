import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { graphql } from '../gql';
import { clearToken } from '../lib/auth';
import { errorText, userError } from '../lib/errors';

const HOME = graphql(`
  query Home {
    me {
      id
      name
    }
    workspaces {
      id
      name
      slug
    }
  }
`);

const CREATE_WORKSPACE = graphql(`
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) {
      __typename
      ... on CreateWorkspacePayload {
        workspace {
          id
          name
          slug
        }
      }
      ... on UserError {
        message
      }
    }
  }
`);

export function HomePage() {
  const { data, loading, error } = useQuery(HOME);
  const [create, { loading: creating }] = useMutation(CREATE_WORKSPACE, { refetchQueries: [HOME] });
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  if (loading) return <div className="center">Loading…</div>;
  if (error) return <div className="center form-error">{error.message}</div>;
  if (data?.workspaces.length) return <Navigate to={`/w/${data.workspaces[0].slug}`} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      const res = await create({ variables: { input: { name, slug } } });
      setFormError(userError(res.data?.createWorkspace));
    } catch (err) {
      setFormError(errorText(err));
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>Welcome, {data?.me?.name}</h1>
        <p>Create your first workspace to start tracking work.</p>
        <label>
          Workspace name
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
            }}
            required
          />
        </label>
        <label>
          URL slug
          <input value={slug} onChange={(e) => setSlug(e.target.value)} required pattern="[a-z0-9-]{2,30}" />
        </label>
        {formError && <p className="form-error" role="alert">{formError}</p>}
        <button className="btn btn-primary" disabled={creating}>Create workspace</button>
        <button type="button" className="link" onClick={() => { clearToken(); location.assign('/login'); }}>
          Sign out
        </button>
      </form>
    </div>
  );
}
