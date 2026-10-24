import { GraphQLError } from 'graphql';

// Brute-force protection for `login`: after MAX failures for one email, refuse further attempts
// (even correct ones) until the window ends. In-memory => per process; use Redis when scaling out.
// Trade-off: keyed by email, so an attacker can temporarily lock a victim out. Keying by IP+email
// avoids that but lets a botnet through; real systems usually add CAPTCHA / exponential backoff.
const MAX = Number(process.env.LOGIN_MAX_FAILURES ?? 5);
const WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS ?? 15 * 60_000);

const failures = new Map<string, { count: number; resetAt: number }>();

export function assertLoginAllowed(key: string) {
  const entry = failures.get(key);
  if (!entry) return;
  if (Date.now() >= entry.resetAt) return void failures.delete(key);
  if (entry.count >= MAX) {
    throw new GraphQLError('Too many failed login attempts. Try again later.', {
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: Math.ceil((entry.resetAt - Date.now()) / 1000) },
    });
  }
}

export function recordLoginFailure(key: string) {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || now >= entry.resetAt) failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count++;
}

export const clearLoginFailures = (key: string) => void failures.delete(key);
