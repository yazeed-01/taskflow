import { useState } from 'react';
import { useMutation, useQuery, useSubscription } from '@apollo/client';
import { graphql } from '../gql';
import { addNotificationToInbox } from '../lib/cache';
import { useToast } from './Toasts';

const NOTIFICATIONS = graphql(`
  query Notifications {
    notifications(first: 20) {
      unreadCount
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
          read
          createdAt
          activity {
            id
            summary
            issue {
              id
            }
          }
        }
      }
    }
  }
`);

const NOTIFICATION_RECEIVED = graphql(`
  subscription NotificationReceived {
    notificationReceived {
      id
      read
      createdAt
      activity {
        id
        summary
        issue {
          id
        }
      }
    }
  }
`);

const MARK_READ = graphql(`
  mutation MarkNotificationsRead($input: MarkNotificationsReadInput!) {
    markNotificationsRead(input: $input) {
      unreadCount
    }
  }
`);

export function NotificationBell({ onOpenIssue }: { onOpenIssue: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const { data } = useQuery(NOTIFICATIONS);
  const [markRead] = useMutation(MARK_READ, { refetchQueries: [NOTIFICATIONS] });

  // Live: a notification pushed by the server is normalized into the cache and prepended to the inbox.
  useSubscription(NOTIFICATION_RECEIVED, {
    onData: ({ client, data }) => {
      const n = data.data?.notificationReceived;
      if (!n) return;
      addNotificationToInbox(client.cache, n.id);
      toast(n.activity.summary);
    },
  });

  const unread = data?.notifications.unreadCount ?? 0;
  const edges = data?.notifications.edges ?? [];

  return (
    <div className="bell">
      <button className="icon-btn" onClick={() => setOpen((o) => !o)} aria-label={`Notifications, ${unread} unread`}>
        🔔{unread > 0 && <span className="badge" data-testid="unread-badge">{unread}</span>}
      </button>
      {open && (
        <div className="popover">
          <div className="popover-head">
            <strong>Notifications</strong>
            <button className="link" disabled={unread === 0} onClick={() => markRead({ variables: { input: { ids: null } } })}>
              Mark all read
            </button>
          </div>
          {edges.length === 0 && <p className="muted pad">Nothing yet.</p>}
          <ul className="notif-list">
            {edges.map(({ node }) => (
              <li key={node.id}>
                <button
                  className={`notif${node.read ? '' : ' notif-unread'}`}
                  onClick={() => {
                    if (!node.read) void markRead({ variables: { input: { ids: [node.id] } } });
                    if (node.activity.issue) onOpenIssue(node.activity.issue.id);
                    setOpen(false);
                  }}
                >
                  <span>{node.activity.summary}</span>
                  <time className="muted">{new Date(node.createdAt).toLocaleString()}</time>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
