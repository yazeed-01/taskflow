import { useParams } from 'react-router-dom';
import { useQuery, useSubscription } from '@apollo/client';
import { graphql } from '../gql';
import { addActivityToFeed } from '../lib/cache';
import { initials } from '../components/IssueCard';
import { useWorkspace } from '../lib/workspaceContext';

const ACTIVITY = graphql(`
  query ActivityFeed($slug: String!, $after: String) {
    workspace(slug: $slug) {
      id
      activity(first: 20, after: $after) {
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
            summary
            type
            createdAt
            actor {
              id
              name
            }
            issue {
              id
            }
          }
        }
      }
    }
  }
`);

const ACTIVITY_ADDED = graphql(`
  subscription ActivityAdded($workspaceId: ID!) {
    activityAdded(workspaceId: $workspaceId) {
      id
      summary
      type
      createdAt
      actor {
        id
        name
      }
      issue {
        id
      }
    }
  }
`);

export function ActivityPage() {
  const { slug = '' } = useParams();
  const { workspace, openIssue } = useWorkspace();
  const { data, loading, error, fetchMore } = useQuery(ACTIVITY, { variables: { slug } });

  useSubscription(ACTIVITY_ADDED, {
    variables: { workspaceId: workspace.id },
    onData: ({ client, data: sub }) => {
      const a = sub.data?.activityAdded;
      if (a) addActivityToFeed(client.cache, workspace.id, a.id);
    },
  });

  const feed = data?.workspace?.activity;

  return (
    <div>
      <div className="page-head">
        <h1>Activity</h1>
        <span className="live"><span className="dot" /> live</span>
      </div>
      {error && <p className="form-error">{error.message}</p>}
      {loading && !feed && <p className="muted">Loading…</p>}
      <ul className="feed">
        {feed?.edges.map(({ node }) => (
          <li key={node.id}>
            <span className="avatar">{initials(node.actor.name)}</span>
            <div>
              {node.issue ? (
                <button className="link" onClick={() => openIssue(node.issue!.id)}>{node.summary}</button>
              ) : (
                <span>{node.summary}</span>
              )}
              <div className="muted small">{new Date(node.createdAt).toLocaleString()}</div>
            </div>
          </li>
        ))}
      </ul>
      {feed?.pageInfo.hasNextPage && (
        <div className="center-row">
          <button className="btn" onClick={() => fetchMore({ variables: { after: feed.pageInfo.endCursor } })}>
            Older activity
          </button>
        </div>
      )}
    </div>
  );
}
