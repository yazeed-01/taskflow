import { useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useSubscription } from '@apollo/client';
import { DragDropContext, Draggable, Droppable, type DropResult } from '@hello-pangea/dnd';
import { getFragmentData, graphql } from '../gql';
import type { IssueStatus } from '../gql/graphql';
import { IssueCard, IssueCardFragment } from '../components/IssueCard';
import { useToast } from '../components/Toasts';
import { useWorkspace } from '../lib/workspaceContext';
import { addIssueToProject } from '../lib/cache';
import { errorText, userError } from '../lib/errors';
import { positionBetween } from '../lib/position';

const BOARD = graphql(`
  query Board($projectId: ID!, $after: String) {
    project(id: $projectId) {
      id
      name
      key
      description
      issues(first: 100, after: $after) {
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
          }
        }
      }
    }
  }
`);

const MOVE_ISSUE = graphql(`
  mutation MoveIssue($input: MoveIssueInput!) {
    moveIssue(input: $input) {
      __typename
      ... on MoveIssuePayload {
        issue {
          __typename
          id
          status
          position
        }
      }
      ... on UserError {
        message
      }
    }
  }
`);

const CREATE_ISSUE = graphql(`
  mutation CreateIssue($input: CreateIssueInput!) {
    createIssue(input: $input) {
      __typename
      ... on CreateIssuePayload {
        issue {
          id
          ...IssueCard
        }
      }
      ... on UserError {
        message
      }
    }
  }
`);

const ISSUE_EVENTS = graphql(`
  subscription IssueEvents($projectId: ID!) {
    issueEvents(projectId: $projectId) {
      type
      actor {
        id
        name
      }
      issue {
        id
        ...IssueCard
      }
    }
  }
`);

const COLUMNS: { status: IssueStatus; label: string }[] = [
  { status: 'BACKLOG', label: 'Backlog' },
  { status: 'TODO', label: 'Todo' },
  { status: 'IN_PROGRESS', label: 'In Progress' },
  { status: 'DONE', label: 'Done' },
];

export function BoardPage() {
  const { projectId = '' } = useParams();
  const { workspace, me, openIssue } = useWorkspace();
  const toast = useToast();
  const [text, setText] = useState('');
  const [assignee, setAssignee] = useState('all');
  const [composer, setComposer] = useState<IssueStatus | null>(null);
  const [title, setTitle] = useState('');

  const { data, loading, error, fetchMore } = useQuery(BOARD, { variables: { projectId } });
  const [moveIssue] = useMutation(MOVE_ISSUE);
  const [createIssue, { loading: creating }] = useMutation(CREATE_ISSUE);

  // Live board: events from teammates are normalized into the cache by Apollo, which re-renders the
  // card in its new column. A *new* issue also has to be added to this project's list.
  useSubscription(ISSUE_EVENTS, {
    variables: { projectId },
    skip: !projectId,
    onData: ({ client, data: sub }) => {
      const ev = sub.data?.issueEvents;
      if (ev?.type === 'CREATED') addIssueToProject(client.cache, projectId, ev.issue.id);
    },
  });

  const cards = useMemo(
    // `ref` is the masked fragment reference handed to <IssueCard>; `data` is what *this* page may read (sorting/filtering).
    () => (data?.project?.issues.edges ?? []).map((e) => ({ ref: e.node, data: getFragmentData(IssueCardFragment, e.node) })),
    [data],
  );

  const visible = useMemo(() => {
    const q = text.trim().toLowerCase();
    return cards.filter((c) => {
      const d = c.data;
      if (q && !d.title.toLowerCase().includes(q) && !d.identifier.toLowerCase().includes(q)) return false;
      if (assignee === 'me') return d.assignee?.id === me.id;
      if (assignee === 'none') return !d.assignee;
      if (assignee !== 'all') return d.assignee?.id === assignee;
      return true;
    });
  }, [cards, text, assignee, me.id]);

  const byStatus = useMemo(() => {
    const map = new Map<IssueStatus, typeof visible>(COLUMNS.map((c) => [c.status, []]));
    for (const c of visible) map.get(c.data.status)!.push(c);
    for (const list of map.values()) list.sort((a, b) => a.data.position - b.data.position);
    return map;
  }, [visible]);

  function onDragEnd(result: DropResult) {
    const { source, destination, draggableId } = result;
    if (!destination) return;
    if (source.droppableId === destination.droppableId && source.index === destination.index) return;

    const status = destination.droppableId as IssueStatus;
    // Neighbours in the destination column, ignoring the card being moved.
    const column = (byStatus.get(status) ?? []).filter((c) => c.data.id !== draggableId);
    const position = positionBetween(column[destination.index - 1]?.data.position, column[destination.index]?.data.position);

    moveIssue({
      variables: { input: { id: draggableId, status, position } },
      // Optimistic update: the card jumps immediately. If the server refuses (or the network fails),
      // Apollo discards this layer and the card snaps back on its own — no manual rollback code.
      optimisticResponse: {
        moveIssue: { __typename: 'MoveIssuePayload', issue: { __typename: 'Issue', id: draggableId, status, position } },
      },
    })
      .then((res) => {
        const msg = userError(res.data?.moveIssue);
        if (msg) toast(`Couldn't move card: ${msg}`, 'error');
      })
      .catch((e) => toast(`Couldn't move card: ${errorText(e)}`, 'error'));
  }

  async function addIssue(e: FormEvent, status: IssueStatus) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const res = await createIssue({
        variables: { input: { projectId, title, status } },
        update(cache, { data: d }) {
          const r = d?.createIssue;
          if (r?.__typename === 'CreateIssuePayload') addIssueToProject(cache, projectId, r.issue.id);
        },
      });
      const msg = userError(res.data?.createIssue);
      if (msg) return toast(msg, 'error');
      setTitle('');
      setComposer(null);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  if (loading && !data) return <div className="center">Loading board…</div>;
  if (error) return <div className="center form-error">{error.message}</div>;
  if (!data?.project) return <div className="center">Project not found.</div>;

  const { project } = data;
  const { pageInfo, totalCount } = project.issues;

  return (
    <div className="board-page">
      <div className="page-head">
        <div>
          <h1>{project.name}</h1>
          {project.description && <p className="muted">{project.description}</p>}
        </div>
        <div className="row">
          <input className="search" placeholder="Filter cards…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Filter cards" />
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Filter by assignee">
            <option value="all">Everyone</option>
            <option value="me">Assigned to me</option>
            <option value="none">Unassigned</option>
            {workspace.members.map((m) => (
              <option key={m.user.id} value={m.user.id}>{m.user.name}</option>
            ))}
          </select>
        </div>
      </div>

      <DragDropContext onDragEnd={onDragEnd}>
        <div className="columns">
          {COLUMNS.map(({ status, label }) => {
            const list = byStatus.get(status) ?? [];
            return (
              <section key={status} className="column" aria-label={label}>
                <header className="column-head">
                  <span>{label}</span>
                  <span className="count">{list.length}</span>
                </header>
                <Droppable droppableId={status}>
                  {(drop, snapshot) => (
                    <div ref={drop.innerRef} {...drop.droppableProps} className={`column-body${snapshot.isDraggingOver ? ' over' : ''}`}>
                      {list.map((card, index) => (
                        <Draggable key={card.data.id} draggableId={card.data.id} index={index}>
                          {(drag, snap) => (
                            <div ref={drag.innerRef} {...drag.draggableProps} {...drag.dragHandleProps}>
                              <IssueCard issue={card.ref} onOpen={openIssue} dragging={snap.isDragging} />
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {drop.placeholder}
                    </div>
                  )}
                </Droppable>
                {composer === status ? (
                  <form className="composer" onSubmit={(e) => addIssue(e, status)}>
                    <input autoFocus placeholder="Issue title" value={title} onChange={(e) => setTitle(e.target.value)} />
                    <div className="row">
                      <button className="btn btn-primary btn-sm" disabled={creating}>Add</button>
                      <button type="button" className="btn btn-sm" onClick={() => setComposer(null)}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <button className="add-card" onClick={() => setComposer(status)}>+ Add issue</button>
                )}
              </section>
            );
          })}
        </div>
      </DragDropContext>

      {pageInfo.hasNextPage && (
        <div className="center-row">
          <button className="btn" onClick={() => fetchMore({ variables: { projectId, after: pageInfo.endCursor } })}>
            Load more ({cards.length} of {totalCount})
          </button>
        </div>
      )}
    </div>
  );
}
