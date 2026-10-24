import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useSubscription } from '@apollo/client';
import { getFragmentData, graphql } from '../gql';
import type { IssuePriority } from '../gql/graphql';
import { IssueCardFragment, PRIORITY_LABEL, initials } from './IssueCard';
import { useToast } from './Toasts';
import { useWorkspace } from '../lib/workspaceContext';
import { addCommentToIssue } from '../lib/cache';
import { errorText, userError } from '../lib/errors';

const ISSUE_DETAIL = graphql(`
  query IssueDetail($id: ID!) {
    issue(id: $id) {
      id
      ...IssueCard
      description
      createdAt
      reporter {
        id
        name
      }
      comments {
        id
        body
        createdAt
        author {
          id
          name
        }
      }
    }
  }
`);

const UPDATE_ISSUE = graphql(`
  mutation UpdateIssue($input: UpdateIssueInput!) {
    updateIssue(input: $input) {
      __typename
      ... on UpdateIssuePayload {
        issue {
          __typename
          id
          ...IssueCard
          description
        }
      }
      ... on UserError {
        message
      }
    }
  }
`);

const ADD_COMMENT = graphql(`
  mutation AddComment($input: AddCommentInput!) {
    addComment(input: $input) {
      __typename
      ... on AddCommentPayload {
        comment {
          __typename
          id
          body
          createdAt
          author {
            __typename
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

const COMMENT_ADDED = graphql(`
  subscription CommentAdded($issueId: ID!) {
    commentAdded(issueId: $issueId) {
      id
      body
      createdAt
      author {
        id
        name
      }
    }
  }
`);

const PRIORITIES = Object.keys(PRIORITY_LABEL) as IssuePriority[];

export function IssueModal({ issueId, onClose }: { issueId: string; onClose: () => void }) {
  const { workspace, me } = useWorkspace();
  const toast = useToast();
  const { data, loading } = useQuery(ISSUE_DETAIL, { variables: { id: issueId } });
  const [updateIssue] = useMutation(UPDATE_ISSUE);
  const [addComment, { loading: posting }] = useMutation(ADD_COMMENT);
  const [comment, setComment] = useState('');
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState<string | null>(null);

  useSubscription(COMMENT_ADDED, {
    variables: { issueId },
    onData: ({ client, data: sub }) => {
      const c = sub.data?.commentAdded;
      if (c) addCommentToIssue(client.cache, issueId, c.id);
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const issue = data?.issue;
  const card = issue ? getFragmentData(IssueCardFragment, issue) : null;

  /** Apply a partial edit. The UI updates instantly (optimistic) and rolls back by itself on failure. */
  function edit(patch: {
    title?: string;
    description?: string;
    priority?: IssuePriority;
    assigneeId?: string | null;
    labelIds?: string[];
  }) {
    if (!issue || !card) return;
    const assignee =
      patch.assigneeId === undefined
        ? card.assignee
        : patch.assigneeId === null
          ? null
          : (() => {
              const m = workspace.members.find((x) => x.user.id === patch.assigneeId);
              return m ? { __typename: 'User' as const, id: m.user.id, name: m.user.name } : card.assignee;
            })();
    const labels = patch.labelIds
      ? workspace.labels.filter((l) => patch.labelIds!.includes(l.id)).map((l) => ({ __typename: 'Label' as const, ...l }))
      : card.labels;

    updateIssue({
      variables: { input: { id: issue.id, ...patch } },
      optimisticResponse: {
        updateIssue: {
          __typename: 'UpdateIssuePayload',
          issue: {
            __typename: 'Issue',
            id: issue.id,
            identifier: card.identifier,
            title: patch.title ?? card.title,
            status: card.status,
            priority: patch.priority ?? card.priority,
            position: card.position,
            description: patch.description ?? issue.description ?? null,
            assignee: assignee ? { __typename: 'User', id: assignee.id, name: assignee.name } : null,
            labels,
          },
        },
      },
    })
      .then((res) => {
        const msg = userError(res.data?.updateIssue);
        if (msg) toast(`Couldn't save: ${msg}`, 'error');
      })
      .catch((e) => toast(`Couldn't save: ${errorText(e)}`, 'error'));
  }

  async function postComment(e: FormEvent) {
    e.preventDefault();
    const body = comment.trim();
    if (!body) return;
    setComment('');
    try {
      const res = await addComment({
        variables: { input: { issueId, body } },
        optimisticResponse: {
          addComment: {
            __typename: 'AddCommentPayload',
            comment: {
              __typename: 'Comment',
              id: `optimistic-${Date.now()}`,
              body,
              createdAt: new Date().toISOString(),
              author: { __typename: 'User', id: me.id, name: me.name },
            },
          },
        },
        update(cache, { data: d }) {
          const r = d?.addComment;
          if (r?.__typename === 'AddCommentPayload') addCommentToIssue(cache, issueId, r.comment.id);
        },
      });
      const msg = userError(res.data?.addComment);
      if (msg) {
        toast(msg, 'error');
        setComment(body);
      }
    } catch (err) {
      toast(errorText(err), 'error');
      setComment(body);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Issue details" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose} aria-label="Close">✕</button>
        {loading && !issue && <p className="pad">Loading…</p>}
        {!loading && !issue && <p className="pad">Issue not found.</p>}
        {issue && card && (
          <div className="modal-grid">
            <div className="modal-main">
              <div className="card-id">{card.identifier}</div>
              <input
                className="title-input"
                value={titleDraft ?? card.title}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => {
                  if (titleDraft !== null && titleDraft.trim() && titleDraft !== card.title) edit({ title: titleDraft });
                  setTitleDraft(null);
                }}
                aria-label="Title"
              />
              <textarea
                className="desc-input"
                placeholder="Add a description…"
                value={descDraft ?? issue.description ?? ''}
                onChange={(e) => setDescDraft(e.target.value)}
                onBlur={() => {
                  if (descDraft !== null && descDraft !== (issue.description ?? '')) edit({ description: descDraft });
                  setDescDraft(null);
                }}
                aria-label="Description"
              />

              <h3>Comments</h3>
              <ul className="comments">
                {issue.comments.map((c) => (
                  <li key={c.id}>
                    <span className="avatar">{initials(c.author.name)}</span>
                    <div>
                      <strong>{c.author.name}</strong> <time className="muted">{new Date(c.createdAt).toLocaleString()}</time>
                      <p>{c.body}</p>
                    </div>
                  </li>
                ))}
                {issue.comments.length === 0 && <li className="muted">No comments yet.</li>}
              </ul>
              <form className="comment-form" onSubmit={postComment}>
                <input placeholder="Write a comment…" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="New comment" />
                <button className="btn btn-primary" disabled={posting || !comment.trim()}>Comment</button>
              </form>
            </div>

            <aside className="modal-side">
              <label>
                Status
                <div className="static">{card.status.replace('_', ' ').toLowerCase()}</div>
              </label>
              <label>
                Priority
                <select value={card.priority} onChange={(e) => edit({ priority: e.target.value as IssuePriority })}>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
                  ))}
                </select>
              </label>
              <label>
                Assignee
                <select value={card.assignee?.id ?? ''} onChange={(e) => edit({ assigneeId: e.target.value || null })}>
                  <option value="">Unassigned</option>
                  {workspace.members.map((m) => (
                    <option key={m.user.id} value={m.user.id}>{m.user.name}</option>
                  ))}
                </select>
              </label>
              <div>
                <div className="label-title">Labels</div>
                <div className="chips">
                  {workspace.labels.map((l) => {
                    const on = card.labels.some((x) => x.id === l.id);
                    return (
                      <button
                        key={l.id}
                        className={`chip chip-btn${on ? ' chip-on' : ''}`}
                        style={{ borderColor: l.color, color: on ? '#fff' : l.color, background: on ? l.color : 'transparent' }}
                        onClick={() => edit({ labelIds: on ? card.labels.filter((x) => x.id !== l.id).map((x) => x.id) : [...card.labels.map((x) => x.id), l.id] })}
                      >
                        {l.name}
                      </button>
                    );
                  })}
                  {workspace.labels.length === 0 && <span className="muted">No labels in this workspace</span>}
                </div>
              </div>
              <div className="muted small">Reported by {issue.reporter.name}<br />{new Date(issue.createdAt).toLocaleString()}</div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
