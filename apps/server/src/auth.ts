import type { Database } from 'bun:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { tokenSchema, usernameSchema } from '@nf-hub/protocol';
import type { Config } from './config';
import { audit } from './db';
import { fail, validated } from './errors';

const SESSION_MS = 12 * 60 * 60 * 1000;
export const secret = (bytes: number) => randomBytes(bytes).toString('base64url');
export const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const safeMatch = (a: string, b: string) => timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'));
export async function initializeAdmin(db: Database, username: string, password: string, now = Date.now()) {
  validated(usernameSchema, username);
  if (password.length < 12 || password.length > 512) throw new Error('Administrator password must be 12–512 characters');
  const hash = await Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 });
  db.transaction(() => {
    if (db.query('SELECT 1 FROM admin').get()) fail(409,'CONFLICT');
    db.query('INSERT INTO admin VALUES(1,?,?)').run(username, hash); audit(db,now,'admin.init');
  }).immediate();
}
export interface WebSession { tokenHash: string; csrfToken: string; username: string }
const cookieName = (cfg: Config) => cfg.devHttp ? 'nf_hub_dev' : '__Host-nf_hub';
export function sessionCookie(cfg: Config, value: string, logout = false) {
  return `${cookieName(cfg)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${logout ? 0 : SESSION_MS / 1000}${cfg.devHttp ? '' : '; Secure'}`;
}
export async function login(db: Database, username: string, password: string, clock: () => number) {
  const admin = db.query<{username:string; passwordHash:string},[]>('SELECT username,passwordHash FROM admin').get();
  if (!admin) fail(401,'UNAUTHENTICATED');
  const ok = await Bun.password.verify(password, admin.passwordHash);
  if (!safeMatch(username, admin.username) || !ok) fail(401,'UNAUTHENTICATED');
  const token = secret(32), csrfToken = secret(32), now = clock();
  db.transaction(() => {
    db.query('DELETE FROM admin_sessions WHERE expiresAt<=?').run(now);
    db.query('INSERT INTO admin_sessions VALUES(?,?,?)').run(digest(token),csrfToken,now + SESSION_MS);
    db.query('DELETE FROM admin_sessions WHERE tokenHash IN (SELECT tokenHash FROM admin_sessions ORDER BY expiresAt DESC,rowid DESC LIMIT -1 OFFSET 32)').run();
    audit(db,now,'auth.login');
  }).immediate();
  return { token, auth: {username: admin.username, csrfToken} };
}
export function webSession(db: Database, cfg: Config, req: Request, now: number): WebSession {
  if (req.headers.has('authorization')) fail(401,'UNAUTHENTICATED');
  const name = `${cookieName(cfg)}=`;
  const values = (req.headers.get('cookie') || '').split(';').map(s => s.trim()).filter(s => s.startsWith(name));
  const token = values.length === 1 ? values[0]!.slice(name.length) : '';
  if (!tokenSchema.safeParse(token).success) fail(401,'UNAUTHENTICATED');
  const row = db.query<WebSession,[string,number]>('SELECT s.tokenHash,s.csrfToken,a.username FROM admin_sessions s CROSS JOIN admin a WHERE s.tokenHash=? AND s.expiresAt>?').get(digest(token),now);
  return row ?? fail(401,'UNAUTHENTICATED');
}
export function verifyOrigin(cfg: Config, req: Request) { if (req.headers.get('origin') !== cfg.publicUrl.origin) fail(403,'BAD_ORIGIN'); }
export function verifyCsrf(req: Request, session: WebSession) {
  const input = req.headers.get('x-csrf-token');
  if (!input || input.length !== session.csrfToken.length || !safeMatch(input,session.csrfToken)) fail(403,'CSRF');
}
export function logout(db: Database, session: WebSession, now: number) {
  db.transaction(() => { db.query('DELETE FROM admin_sessions WHERE tokenHash=?').run(session.tokenHash); audit(db,now,'auth.logout'); }).immediate();
}
