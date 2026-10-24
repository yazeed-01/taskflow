import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { getFragmentData, graphql } from '../gql';
import type { IssueFilter, IssueOrder, IssueStatus } from '../gql/graphql';
import { IssueCardFragment, PRIORITY_LABEL, initials } from '../components/IssueCard';
import { useWorkspace } from '../lib/workspaceContext';

const SEARCH = graphql(`
  query SearchIssues($slug: String!, $filter: IssueFilter, $orderBy: IssueOrder, $after: String) {
    workspace(slug: $slug) {
      id
      issues(first: 20, after: $after, filter: $filter, orderBy: $orderBy) {
        totalCount
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        edges {
          cursor
          node {
            id
            ...IssueCard
            project {
              id
              name
            }
          }
        }
      }
    }
  }
`);

const STATUSES: IssueStatus[] = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'DONE'];

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function SearchPage() {
  const { slug = '' } = useParams();
  const { workspace, openIssue } = useWorkspace();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<IssueStatus | ''>('');
  const [assignee, setAssignee] = useState('');
  const [labelId, setLabelId] = useState('');
  const [orderBy, setOrderBy] = useState<IssueOrder>('NEWEST');
  const search = useDebounced(text);

  // Filtering is done by the server. Each distinct filter/order is its own cached list (keyArgs in
  // apollo.ts); "Load more" appends the next cursor page to the *current* one.
  const filter = useMemo<IssueFilter>(
    () => ({
      ...(search.trim() && { search: search.trim() }),
      ...(status && { status }),
      ...(assignee === 'none' ? { unassigned: true } : assignee ? { assigneeId: assignee } : {}),
      ...(labelId && { labelId }),
    }),
    [search, status, assignee, labelId],
  );

  const { data, loading, error, fetchMore } = useQuery(SEARCH, { variables: { slug, filter, orderBy } });
  const conn = data?.workspace?.issues;

  return (
    <div>
      <div className="page-head">
        <h1>Search issues</h1>
      </div>
      <div className="filters">
        <input className="search" placeholder="Search titles…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search" autoFocus />
        <select value={status} onChange={(e) => setStatus(e.target.value as IssueStatus | '')} aria-label="Status">
          <option value="">Any status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}
        </select>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assignee">
          <option value="">Anyone</option>
          <option value="none">Unassigned</option>
          {workspace.members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}
        </select>
        <select value={labelId} onChange={(e) => setLabelId(e.target.value)} aria-label="Label">
          <option value="">Any label</option>
          {workspace.labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select value={orderBy} onChange={(e) => setOrderBy(e.target.value as IssueOrder)} aria-label="Order">
          <option value="NEWEST">Newest first</option>
          <option value="POSITION">Board order</option>
        </select>
      </div>

      {error && <p className="form-error">{error.message}</p>}
      {conn && (
        <p className="muted" data-testid="result-count">
          {conn.totalCount} {conn.totalCount === 1 ? 'issue' : 'issues'}
        </p>
      )}
      <ul className="results">
        {conn?.edges.map(({ node }) => {
          const i = getFragmentData(IssueCardFragment, node);
          return (
            <li key={node.id}>
              <button className="result" onClick={() => openIssue(node.id)}>
                <span className="card-id">{i.identifier}</span>
                <span className="result-title">{i.title}</span>
                <span className="muted">{node.project.name}</span>
                <span className="status-pill">{i.status.replace('_', ' ').toLowerCase()}</span>
                <span className={`prio prio-${i.priority.toLowerCase()}`} title={PRIORITY_LABEL[i.priority]} />
                {i.assignee ? <span className="avatar" title={i.assignee.name}>{initials(i.assignee.name)}</span> : <span className="avatar avatar-empty" />}
              </button>
            </li>
          );
        })}
      </ul>
      {!loading && conn?.edges.length === 0 && <p className="muted">No issues match.</p>}
      {conn?.pageInfo.hasNextPage && (
        <div className="center-row">
          <button className="btn" disabled={loading} onClick={() => fetchMore({ variables: { after: conn.pageInfo.endCursor } })}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
