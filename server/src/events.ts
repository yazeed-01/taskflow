import { PubSub } from 'graphql-subscriptions';

// In-memory pub/sub: fine for one server process. To run several instances, swap this for a shared
// broker (e.g. graphql-redis-subscriptions) — every `pubsub.publish` / `asyncIterableIterator` call
// site stays the same.
export const pubsub = new PubSub();

export const TOPIC = {
  issue: 'ISSUE_EVENT',
  comment: 'COMMENT_ADDED',
  activity: 'ACTIVITY_ADDED',
  notification: 'NOTIFICATION_RECEIVED',
} as const;
