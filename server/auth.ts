import crypto from 'node:crypto';
import type { ServerDatabase } from './postgres.ts';
import type { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';

export interface AuthContext {
  sessionId: string;
  userId: string;
  username: string;
  fullName: string;
  email: string;
  role: string;
  companyId: string | null;
  companyName: string | null;
  companyStatus: string | null;
  employeeRecordId: string | null;
  employeeId: string | null;
  mustChangePassword: boolean;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

export const SESSION_COOKIE_NAME = 'smartattend_session';
const SESSION_TTL_HOURS = 24;
const MAX_FAILED_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export function validatePasswordStrength(password: string): string | null {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must include uppercase, lowercase, and numeric characters.';
  }
  return null;
}

export function validateUsernameFormat(username: string): string | null {
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 40) {
    return 'Username must be between 3 and 40 characters.';
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    return 'Username may only contain letters, numbers, dots, underscores, and hyphens.';
  }
  return null;
}

export function generateRandomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function generateSecureTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '@#$!';
  const pick = (pool: string) => pool[crypto.randomInt(0, pool.length)];
  const chars = [
    pick(upper),
    pick(upper),
    pick(lower),
    pick(lower),
    pick(lower),
    pick(digits),
    pick(digits),
    pick(symbols),
    pick(lower),
    pick(digits),
  ];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return chars.join('');
}

export function isIdentifierTaken(db: ServerDatabase, identifier: string): boolean {
  const row = db
    .prepare('SELECT identifier FROM login_identifiers WHERE identifier = ? COLLATE NOCASE')
    .get(identifier.trim()) as { identifier: string } | undefined;
  return Boolean(row);
}

/**
 * Must be called inside an active PostgreSQL write transaction (BEGIN).
 */
export function generateNextCompanyId(db: ServerDatabase): string {
  const row = db.prepare('SELECT last_value FROM id_sequences WHERE seq_name = ?').get('company_seq') as
    | { last_value: number }
    | undefined;
  let nextVal = (row?.last_value ?? 0) + 1;
  while (true) {
    const candidate = `CMP-${String(nextVal).padStart(3, '0')}`;
    const exists = db.prepare('SELECT company_id FROM companies WHERE company_id = ?').get(candidate);
    if (!exists) {
      db.prepare(
        'INSERT INTO id_sequences (seq_name, last_value) VALUES (?, ?) ON CONFLICT(seq_name) DO UPDATE SET last_value = excluded.last_value'
      ).run('company_seq', nextVal);
      return candidate;
    }
    nextVal += 1;
  }
}

/**
 * Must be called inside an active PostgreSQL write transaction (BEGIN).
 * Checks both `employees.employee_id` and `login_identifiers` to guarantee zero collision with any username or employee ID.
 */
export function generateNextEmployeeId(db: ServerDatabase, excludeIdentifier?: string): string {
  const row = db.prepare('SELECT last_value FROM id_sequences WHERE seq_name = ?').get('employee_seq') as
    | { last_value: number }
    | undefined;
  let nextVal = (row?.last_value ?? 0) + 1;
  const excluded = excludeIdentifier ? excludeIdentifier.trim().toLowerCase() : '';
  while (true) {
    const candidate = `EMP${String(nextVal).padStart(4, '0')}`;
    const matchesExcluded = excluded && candidate.toLowerCase() === excluded;
    const takenInRegistry = isIdentifierTaken(db, candidate);
    const takenInEmployees = db
      .prepare('SELECT employee_id FROM employees WHERE employee_id = ? COLLATE NOCASE')
      .get(candidate);
    if (!matchesExcluded && !takenInRegistry && !takenInEmployees) {
      db.prepare(
        'INSERT INTO id_sequences (seq_name, last_value) VALUES (?, ?) ON CONFLICT(seq_name) DO UPDATE SET last_value = excluded.last_value'
      ).run('employee_seq', nextVal);
      return candidate;
    }
    nextVal += 1;
  }
}

export function recordAuditLog(
  db: ServerDatabase,
  entry: {
    companyId: string | null;
    actorUserId: string | null;
    actorUsername: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    outcome: 'success' | 'failure' | 'denied';
    details?: string;
    ipAddress?: string;
  }
): void {
  db.prepare(`
    INSERT INTO audit_logs (log_id, company_id, actor_user_id, actor_username, action, target_type, target_id, outcome, details, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generateId('aud'),
    entry.companyId,
    entry.actorUserId,
    entry.actorUsername,
    entry.action,
    entry.targetType ?? null,
    entry.targetId ?? null,
    entry.outcome,
    entry.details ?? null,
    entry.ipAddress ?? null,
    new Date().toISOString()
  );
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || '127.0.0.1';
}

export function checkRateLimit(db: ServerDatabase, rateKey: string): { allowed: boolean; retryAfterSeconds?: number } {
  const row = db
    .prepare('SELECT attempts, first_attempt_at, locked_until FROM login_rate_limits WHERE rate_key = ?')
    .get(rateKey) as { attempts: number; first_attempt_at: string; locked_until: string | null } | undefined;

  if (!row) return { allowed: true };

  const now = Date.now();
  if (row.locked_until) {
    const lockUntilMs = Date.parse(row.locked_until);
    if (lockUntilMs > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((lockUntilMs - now) / 1000) };
    }
    db.prepare('DELETE FROM login_rate_limits WHERE rate_key = ?').run(rateKey);
    return { allowed: true };
  }

  const firstAttemptMs = Date.parse(row.first_attempt_at);
  if (now - firstAttemptMs > RATE_LIMIT_WINDOW_MS) {
    db.prepare('DELETE FROM login_rate_limits WHERE rate_key = ?').run(rateKey);
    return { allowed: true };
  }

  return { allowed: true };
}

export function recordFailedAttempt(db: ServerDatabase, rateKey: string): { locked: boolean; attemptsRemaining: number } {
  const nowIso = new Date().toISOString();
  const row = db
    .prepare('SELECT attempts, first_attempt_at FROM login_rate_limits WHERE rate_key = ?')
    .get(rateKey) as { attempts: number; first_attempt_at: string } | undefined;

  if (!row || Date.now() - Date.parse(row.first_attempt_at) > RATE_LIMIT_WINDOW_MS) {
    db.prepare(
      'INSERT INTO login_rate_limits (rate_key, attempts, first_attempt_at, locked_until) VALUES (?, 1, ?, NULL) ON CONFLICT(rate_key) DO UPDATE SET attempts = 1, first_attempt_at = excluded.first_attempt_at, locked_until = NULL'
    ).run(rateKey, nowIso);
    return { locked: false, attemptsRemaining: MAX_FAILED_ATTEMPTS - 1 };
  }

  const nextAttempts = row.attempts + 1;
  const lockedUntil =
    nextAttempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + RATE_LIMIT_WINDOW_MS).toISOString() : null;

  db.prepare('UPDATE login_rate_limits SET attempts = ?, locked_until = ? WHERE rate_key = ?').run(
    nextAttempts,
    lockedUntil,
    rateKey
  );

  return {
    locked: Boolean(lockedUntil),
    attemptsRemaining: Math.max(0, MAX_FAILED_ATTEMPTS - nextAttempts),
  };
}

export function clearRateLimit(db: ServerDatabase, rateKey: string): void {
  db.prepare('DELETE FROM login_rate_limits WHERE rate_key = ?').run(rateKey);
}

export function createSession(
  db: ServerDatabase,
  params: { userId: string; companyId: string | null; ipAddress?: string; userAgent?: string }
): { rawToken: string; expiresAt: string; sessionId: string } {
  const rawToken = generateRandomToken(32);
  const tokenHash = sha256(rawToken);
  const sessionId = generateId('ses');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();

  db.prepare(`
    INSERT INTO sessions (session_id, token_hash, user_id, company_id, expires_at, ip_address, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    tokenHash,
    params.userId,
    params.companyId,
    expiresAt,
    params.ipAddress ?? null,
    params.userAgent ?? null,
    now.toISOString()
  );

  return { rawToken, expiresAt, sessionId };
}

export function revokeSessionByToken(db: ServerDatabase, rawToken: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(rawToken));
}

export function revokeAllUserSessions(db: ServerDatabase, userId: string): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function revokeAllCompanySessions(db: ServerDatabase, companyId: string): void {
  db.prepare('DELETE FROM sessions WHERE company_id = ?').run(companyId);
}

export function extractSessionToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (typeof cookieToken === 'string' && cookieToken.trim()) {
    return cookieToken.trim();
  }
  return null;
}

export function authenticateSession(db: ServerDatabase) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const rawToken = extractSessionToken(req);
    if (!rawToken) {
      res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHENTICATED' });
      return;
    }

    const tokenHash = sha256(rawToken);
    const row = db
      .prepare(`
        SELECT
          s.session_id, s.expires_at,
          u.user_id, u.username, u.full_name, u.email, u.company_id, u.account_status, u.must_change_password,
          r.role_name,
          c.company_name, c.status AS company_status,
          e.employee_record_id, e.employee_id, e.employment_status
        FROM sessions s
        JOIN users u ON u.user_id = s.user_id
        JOIN roles r ON r.role_id = u.role_id
        LEFT JOIN companies c ON c.company_id = u.company_id
        LEFT JOIN employees e ON e.user_id = u.user_id
        WHERE s.token_hash = ?
      `)
      .get(tokenHash) as
      | {
          session_id: string;
          expires_at: string;
          user_id: string;
          username: string;
          full_name: string;
          email: string;
          company_id: string | null;
          account_status: string;
          must_change_password: number;
          role_name: string;
          company_name: string | null;
          company_status: string | null;
          employee_record_id: string | null;
          employee_id: string | null;
          employment_status: string | null;
        }
      | undefined;

    if (!row) {
      res.status(401).json({ error: 'Invalid or expired session.', code: 'SESSION_INVALID' });
      return;
    }

    if (Date.parse(row.expires_at) <= Date.now()) {
      db.prepare('DELETE FROM sessions WHERE session_id = ?').run(row.session_id);
      res.status(401).json({ error: 'Your session has expired. Please log in again.', code: 'SESSION_EXPIRED' });
      return;
    }

    if (row.account_status !== 'active' || row.employment_status === 'terminated') {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
      res.status(403).json({
        error: 'Your account has been deactivated. Contact your company administrator.',
        code: 'ACCOUNT_DEACTIVATED',
      });
      return;
    }

    if (row.company_id && row.company_status !== 'active') {
      res.status(403).json({
        error: 'Your company workspace is currently suspended. Contact SmartAttend support.',
        code: 'COMPANY_SUSPENDED',
      });
      return;
    }

    req.auth = {
      sessionId: row.session_id,
      userId: row.user_id,
      username: row.username,
      fullName: row.full_name,
      email: row.email,
      role: row.role_name,
      companyId: row.company_id,
      companyName: row.company_name,
      companyStatus: row.company_status,
      employeeRecordId: row.employee_record_id,
      employeeId: row.employee_id,
      mustChangePassword: Boolean(row.must_change_password),
    };

    next();
  };
}

export function requirePasswordChanged(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  if (req.auth.mustChangePassword) {
    res.status(403).json({
      error: 'You must change your temporary password before accessing SmartAttend modules.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
    return;
  }
  next();
}

export function requireRoles(...allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!allowedRoles.includes(req.auth.role)) {
      res.status(403).json({
        error: `Access denied. Required role: ${allowedRoles.join(' or ')}.`,
        code: 'FORBIDDEN_ROLE',
      });
      return;
    }
    next();
  };
}

export function haversineDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}
