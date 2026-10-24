import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const rawSecret = process.env.JWT_SECRET;
if (!rawSecret || rawSecret.length < 16) {
  throw new Error('JWT_SECRET must be set (16+ chars). Copy .env.example to .env');
}
const secret: string = rawSecret;

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);

// Compared against when the email is unknown, so "no such user" and "wrong password" take similar time.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
export const checkPassword = (pw: string, hash: string | null) => bcrypt.compare(pw, hash ?? DUMMY_HASH);

export const signToken = (userId: string) =>
  jwt.sign({}, secret, { subject: userId, expiresIn: '7d', algorithm: 'HS256' });

/** Returns the user id from a valid token, or null (expired, tampered, wrong algorithm). */
export function verifyToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    return typeof payload === 'object' && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}
