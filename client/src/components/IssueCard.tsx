import { getFragmentData, graphql, type FragmentType } from '../gql';

// Each component declares exactly the data it needs. Parents spread `...IssueCard` into their queries
// and pass the (masked) result down; only this component can read these fields. Change what the card
// shows here and every query that renders cards updates with it — no hunting through parent queries.
export const IssueCardFragment = graphql(`
  fragment IssueCard on Issue {
    __typename
    id
    identifier
    title
    status
    priority
    position
    assignee {
      __typename
      id
      name
    }
    labels {
      __typename
      id
      name
      color
    }
  }
`);

export const PRIORITY_LABEL = {
  NONE: 'No priority',
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
} as const;

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

interface Props {
  issue: FragmentType<typeof IssueCardFragment>;
  onOpen?: (id: string) => void;
  dragging?: boolean;
}

export function IssueCard({ issue: ref, onOpen, dragging }: Props) {
  const issue = getFragmentData(IssueCardFragment, ref);
  return (
    <div
      className={`card${dragging ? ' card-dragging' : ''}`}
      onClick={() => onOpen?.(issue.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.(issue.id)}
      data-testid={`card-${issue.identifier}`}
    >
      <div className="card-top">
        <span className="card-id">{issue.identifier}</span>
        <span className={`prio prio-${issue.priority.toLowerCase()}`} title={PRIORITY_LABEL[issue.priority]} />
      </div>
      <div className="card-title">{issue.title}</div>
      <div className="card-bottom">
        <div className="chips">
          {issue.labels.map((l) => (
            <span key={l.id} className="chip" style={{ borderColor: l.color, color: l.color }}>
              {l.name}
            </span>
          ))}
        </div>
        {issue.assignee ? (
          <span className="avatar" title={issue.assignee.name}>
            {initials(issue.assignee.name)}
          </span>
        ) : (
          <span className="avatar avatar-empty" title="Unassigned" />
        )}
      </div>
    </div>
  );
}
