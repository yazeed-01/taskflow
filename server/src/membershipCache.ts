import { roleIn } from './authz.js';

// Subscriptions re-check workspace membership for EVERY event, so a member who is removed mid-stream stops
// receiving. Done naively that is one SQL query per subscriber per event (1,000/s in the fan-out load test).
//
// A positive answer is remembered for a short time. Removing a member calls `forgetMembership`, so the common
// case — an admin removes someone — takes effect immediately. The TTL only covers changes made by *another
// process* (this cache is per-instance): worst case a removed user keeps receiving events for TTL seconds.
const TTL_MS = Number(process.env.MEMBERSHIP_CACHE_TTL_MS ?? 15_000);
const MAX_ENTRIES = 50_000;

const yes = new Map<string, number>(); // "userId|workspaceId" -> expiry (ms). Only positive results are cached.
const key = (userId: string, workspaceId: string) => `${userId}|${workspaceId}`;

export async function isMemberCached(userId: string, workspaceId: string): Promise<boolean> {
  const k = key(userId, workspaceId);
  const until = yes.get(k);
  if (until !== undefined && until > Date.now()) return true;
  const member = !!(await roleIn(userId, workspaceId));
  if (member) {
    if (yes.size >= MAX_ENTRIES) yes.clear(); // crude bound: memory can't grow without limit
    yes.set(k, Date.now() + TTL_MS);
  } else {
    yes.delete(k);
  }
  return member;
}

export const forgetMembership = (userId: string, workspaceId: string) => void yes.delete(key(userId, workspaceId));
