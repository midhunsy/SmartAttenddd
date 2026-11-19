import { Router } from 'express';
import type { ServerDatabase } from '../postgres.ts';
import {
  authenticateSession,
  checkRateLimit,
  clearRateLimit,
  createSession,
  extractSessionToken,
  generateId,
  generateNextCompanyId,
  generateNextEmployeeId,
  generateRandomToken,
  getClientIp,
  hashPassword,
  isIdentifierTaken,
  recordAuditLog,
  recordFailedAttempt,
  revokeAllUserSessions,
  revokeSessionByToken,
  SESSION_COOKIE_NAME,
  sha256,
  validatePasswordStrength,
  validateUsernameFormat,
  verifyPassword,
  type AuthenticatedRequest,
} from '../auth.ts';

function setSessionCookie(res: import('express').Response, token: string, expiresAt: string) {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires: new Date(expiresAt),
    path: '/',
  });
}

export function createAuthRouter(db: ServerDatabase): Router {
  const router = Router();

  router.get('/help-info', (_req, res) => {
    res.json({
      loginGuidance: [
        'Enter your globally unique Username (for example, rahul) or your system-generated Employee ID (for example, EMP0004).',
        'No company code or organization selector is required. SmartAttend automatically routes your session to your registered company.',
        'Usernames and Employee IDs are case-insensitive during sign-in.',
      ],
      passwordResetGuidance: [
        'Select Forgot Password on the sign-in screen and enter your registered email address or username.',
        'Use the single-use verification code sent to your registered inbox within 15 minutes.',
        'For temporary passwords issued by your administrator, you will be prompted to set a personal password on first login.',
      ],
      troubleshooting: [
        'Account Deactivated: Contact your Company Admin or HR team to reactivate your employee profile.',
        'Company Suspended: Contact SmartAttend Enterprise Support if your organization workspace is temporarily suspended.',
        'Locked Out: After 5 consecutive failed sign-in attempts, wait 15 minutes before trying again.',
      ],
      supportContact: {
        email: 'support@smartattend.io',
        phone: '+1 (800) 555-0194',
        hours: 'Monday – Friday, 08:00 – 20:00 UTC',
      },
    });
  });

  router.get('/check-username', (req, res) => {
    const username = String(req.query.username || '').trim();
    const formatError = validateUsernameFormat(username);
    if (formatError) {
      res.json({ available: false, reason: formatError });
      return;
    }
    const taken = isIdentifierTaken(db, username);
    res.json({
      available: !taken,
      reason: taken ? 'This username is already taken or reserved on SmartAttend.' : null,
    });
  });

  router.post('/login', (req, res) => {
    const identifier = String(req.body?.identifier || '').trim();
    const password = String(req.body?.password || '');
    const ip = getClientIp(req);

    if (!identifier || !password) {
      res.status(400).json({ error: 'Username or Employee ID and password are required.' });
      return;
    }

    const rateKey = `${ip}:${identifier.toLowerCase()}`;
    const rate = checkRateLimit(db, rateKey);
    if (!rate.allowed) {
      recordAuditLog(db, {
        companyId: null,
        actorUserId: null,
        actorUsername: identifier,
        action: 'LOGIN_RATE_LIMITED',
        outcome: 'denied',
        details: `Rate limit exceeded for identifier ${identifier}`,
        ipAddress: ip,
      });
      res.status(429).json({
        error: `Too many failed login attempts. Try again in ${Math.ceil((rate.retryAfterSeconds ?? 60) / 60)} minute(s).`,
        code: 'RATE_LIMITED',
      });
      return;
    }

    const userRow = db
      .prepare(`
        SELECT
          u.user_id, u.username, u.password_hash, u.email, u.mobile, u.full_name,
          u.company_id, u.account_status, u.must_change_password,
          r.role_name,
          c.company_name, c.status AS company_status,
          e.employee_record_id, e.employee_id, e.employment_status
        FROM users u
        JOIN roles r ON r.role_id = u.role_id
        LEFT JOIN companies c ON c.company_id = u.company_id
        LEFT JOIN employees e ON e.user_id = u.user_id
        WHERE u.username = ? COLLATE NOCASE
           OR e.employee_id = ? COLLATE NOCASE
      `)
      .get(identifier, identifier) as
      | {
          user_id: string;
          username: string;
          password_hash: string;
          email: string;
          mobile: string;
          full_name: string;
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

    if (!userRow || !verifyPassword(password, userRow.password_hash)) {
      const failState = recordFailedAttempt(db, rateKey);
      recordAuditLog(db, {
        companyId: userRow?.company_id ?? null,
        actorUserId: userRow?.user_id ?? null,
        actorUsername: identifier,
        action: 'LOGIN_FAILED',
        outcome: 'failure',
        details: 'Invalid login identifier or password.',
        ipAddress: ip,
      });
      res.status(401).json({
        error: failState.locked
          ? 'Too many failed login attempts. Account sign-in temporarily locked for 15 minutes.'
          : 'Invalid Username / Employee ID or password.',
        attemptsRemaining: failState.attemptsRemaining,
      });
      return;
    }

    if (userRow.account_status !== 'active' || userRow.employment_status === 'terminated') {
      recordAuditLog(db, {
        companyId: userRow.company_id,
        actorUserId: userRow.user_id,
        actorUsername: userRow.username,
        action: 'LOGIN_BLOCKED_DEACTIVATED',
        outcome: 'denied',
        details: 'Attempted sign-in to deactivated user account.',
        ipAddress: ip,
      });
      res.status(403).json({
        error: 'This account is deactivated. Please contact your Company Admin or HR.',
        code: 'ACCOUNT_DEACTIVATED',
      });
      return;
    }

    if (userRow.company_id && userRow.company_status !== 'active') {
      recordAuditLog(db, {
        companyId: userRow.company_id,
        actorUserId: userRow.user_id,
        actorUsername: userRow.username,
        action: 'LOGIN_BLOCKED_SUSPENDED_COMPANY',
        outcome: 'denied',
        details: `Company ${userRow.company_id} is suspended.`,
        ipAddress: ip,
      });
      res.status(403).json({
        error: 'Your company account is currently suspended. Please contact SmartAttend support.',
        code: 'COMPANY_SUSPENDED',
      });
      return;
    }

    clearRateLimit(db, rateKey);

    const session = createSession(db, {
      userId: userRow.user_id,
      companyId: userRow.company_id,
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
    });

    setSessionCookie(res, session.rawToken, session.expiresAt);

    recordAuditLog(db, {
      companyId: userRow.company_id,
      actorUserId: userRow.user_id,
      actorUsername: userRow.username,
      action: 'LOGIN_SUCCESS',
      outcome: 'success',
      details: `Authenticated via ${identifier.toUpperCase() === userRow.employee_id?.toUpperCase() ? 'Employee ID' : 'Username'}`,
      ipAddress: ip,
    });

    res.json({
      token: session.rawToken,
      expiresAt: session.expiresAt,
      requiresPasswordChange: Boolean(userRow.must_change_password),
      user: {
        userId: userRow.user_id,
        username: userRow.username,
        fullName: userRow.full_name,
        email: userRow.email,
        role: userRow.role_name,
        companyId: userRow.company_id,
        companyName: userRow.company_name,
        employeeRecordId: userRow.employee_record_id,
        employeeId: userRow.employee_id,
        mustChangePassword: Boolean(userRow.must_change_password),
      },
    });
  });

  router.post('/logout', (req, res) => {
    const token = extractSessionToken(req);
    if (token) {
      revokeSessionByToken(db, token);
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/me', authenticateSession(db), (req: AuthenticatedRequest, res) => {
    const auth = req.auth!;
    res.json({
      user: {
        userId: auth.userId,
        username: auth.username,
        fullName: auth.fullName,
        email: auth.email,
        role: auth.role,
        companyId: auth.companyId,
        companyName: auth.companyName,
        companyStatus: auth.companyStatus,
        employeeRecordId: auth.employeeRecordId,
        employeeId: auth.employeeId,
        mustChangePassword: auth.mustChangePassword,
      },
    });
  });

  router.post('/register-company', (req, res) => {
    const {
      companyName,
      companyEmail,
      contactNumber,
      industry,
      address,
      website,
      adminFullName,
      adminEmail,
      adminMobile,
      username,
      password,
      confirmPassword,
    } = req.body || {};

    const cName = String(companyName || '').trim();
    const cEmail = String(companyEmail || '').trim().toLowerCase();
    const cPhone = String(contactNumber || '').trim();
    const cIndustry = String(industry || '').trim();
    const cAddress = String(address || '').trim();
    const cWebsite = website ? String(website).trim() : null;

    const aName = String(adminFullName || '').trim();
    const aEmail = String(adminEmail || '').trim().toLowerCase();
    const aMobile = String(adminMobile || '').trim();
    const aUsername = String(username || '').trim();
    const aPassword = String(password || '');
    const aConfirm = String(confirmPassword || '');

    if (!cName || !cEmail || !cPhone || !cIndustry || !cAddress) {
      res.status(400).json({ error: 'All required company details must be provided.' });
      return;
    }
    if (!aName || !aEmail || !aMobile || !aUsername || !aPassword) {
      res.status(400).json({ error: 'All administrator account fields are required.' });
      return;
    }
    if (aPassword !== aConfirm) {
      res.status(400).json({ error: 'Password and Confirm Password do not match.' });
      return;
    }
    const usernameErr = validateUsernameFormat(aUsername);
    if (usernameErr) {
      res.status(400).json({ error: usernameErr });
      return;
    }
    const pwdErr = validatePasswordStrength(aPassword);
    if (pwdErr) {
      res.status(400).json({ error: pwdErr });
      return;
    }

    const ip = getClientIp(req);
    const now = new Date().toISOString();

    db.exec('BEGIN IMMEDIATE;');
    try {
      const existingCompany = db
        .prepare('SELECT company_id FROM companies WHERE company_email = ? COLLATE NOCASE OR company_name = ? COLLATE NOCASE')
        .get(cEmail, cName);
      if (existingCompany) {
        db.exec('ROLLBACK;');
        res.status(409).json({
          error: 'A company with this company name or official email is already registered.',
          code: 'COMPANY_EXISTS',
        });
        return;
      }

      if (isIdentifierTaken(db, aUsername)) {
        db.exec('ROLLBACK;');
        res.status(409).json({
          error: 'Username is already in use across SmartAttend. Please choose a different global username.',
          code: 'USERNAME_TAKEN',
        });
        return;
      }

      const companyId = generateNextCompanyId(db);
      const userId = generateId('usr');
      const empRecordId = generateId('rec');
      const employeeId = generateNextEmployeeId(db, aUsername);
      const passHash = hashPassword(aPassword);

      // 1. Company record
      db.prepare(`
        INSERT INTO companies (company_id, company_name, company_email, contact_number, industry, address, website, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `).run(companyId, cName, cEmail, cPhone, cIndustry, cAddress, cWebsite, now);

      // 2. Default workspace settings
      db.prepare(`
        INSERT INTO company_settings (company_id, grace_period_minutes, half_day_hours, full_day_hours, workweek_days, require_geofence, support_email, support_phone)
        VALUES (?, 15, 4.5, 8.0, 'Mon,Tue,Wed,Thu,Fri', 1, ?, ?)
      `).run(companyId, cEmail, cPhone);

      const deptOpsId = generateId('dept');
      const deptEngId = generateId('dept');
      const deptHrId = generateId('dept');
      db.prepare('INSERT INTO departments (department_id, company_id, name, code) VALUES (?, ?, ?, ?)').run(deptOpsId, companyId, 'Operations', 'OPS');
      db.prepare('INSERT INTO departments (department_id, company_id, name, code) VALUES (?, ?, ?, ?)').run(deptEngId, companyId, 'Engineering', 'ENG');
      db.prepare('INSERT INTO departments (department_id, company_id, name, code) VALUES (?, ?, ?, ?)').run(deptHrId, companyId, 'Human Resources', 'HR');

      const locId = generateId('loc');
      db.prepare(`
        INSERT INTO office_locations (location_id, company_id, name, address, latitude, longitude, radius_meters, is_active)
        VALUES (?, ?, ?, ?, 37.7749, -122.4194, 300, 1)
      `).run(locId, companyId, `${cName} Headquarters`, cAddress);

      const shiftId = generateId('shift');
      db.prepare(`
        INSERT INTO shifts (shift_id, company_id, name, start_time, end_time, grace_minutes, break_minutes)
        VALUES (?, ?, 'General Day Shift', '09:00', '18:00', 15, 60)
      `).run(shiftId, companyId);

      db.prepare('INSERT INTO holidays (holiday_id, company_id, name, holiday_date, holiday_type) VALUES (?, ?, ?, ?, ?)').run(
        generateId('hol'),
        companyId,
        'Christmas Day',
        '2026-12-25',
        'Public'
      );

      // 3. Company Admin User & Identifier Registry
      db.prepare(`
        INSERT INTO users (user_id, username, password_hash, email, mobile, full_name, company_id, role_id, account_status, must_change_password, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'role_company_admin', 'active', 0, ?)
      `).run(userId, aUsername, passHash, aEmail, aMobile, aName, companyId, now);

      db.prepare('INSERT INTO login_identifiers (identifier, user_id, kind, created_at) VALUES (?, ?, ?, ?)').run(
        aUsername,
        userId,
        'username',
        now
      );

      // 4. Associated Employee record for Admin
      db.prepare(`
        INSERT INTO employees (
          employee_record_id, employee_id, user_id, company_id, employee_name, email, mobile,
          department_id, designation, reporting_manager_id, hod_id, joining_date, employment_type,
          office_location_id, assigned_shift_id, employment_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Company Administrator', NULL, NULL, ?, 'Full-Time', ?, ?, 'active', ?)
      `).run(empRecordId, employeeId, userId, companyId, aName, aEmail, aMobile, deptOpsId, now.slice(0, 10), locId, shiftId, now);

      db.prepare('INSERT INTO login_identifiers (identifier, user_id, kind, created_at) VALUES (?, ?, ?, ?)').run(
        employeeId,
        userId,
        'employee_id',
        now
      );

      // Leave balances for admin
      const balStmt = db.prepare(`
        INSERT INTO leave_balances (balance_id, company_id, employee_record_id, leave_type, total_days, used_days, year)
        VALUES (?, ?, ?, ?, ?, 0, 2026)
      `);
      balStmt.run(generateId('bal'), companyId, empRecordId, 'Annual Leave', 18);
      balStmt.run(generateId('bal'), companyId, empRecordId, 'Sick Leave', 10);
      balStmt.run(generateId('bal'), companyId, empRecordId, 'Casual Leave', 6);

      // Welcome notification
      db.prepare(`
        INSERT INTO notifications (notification_id, company_id, user_id, title, message, category, is_read, created_at)
        VALUES (?, ?, ?, 'Workspace Initialized', ?, 'System', 0, ?)
      `).run(
        generateId('ntf'),
        companyId,
        userId,
        `Company ${cName} (${companyId}) created. Your Employee ID is ${employeeId}.`,
        now
      );

      db.exec('COMMIT;');

      recordAuditLog(db, {
        companyId,
        actorUserId: userId,
        actorUsername: aUsername,
        action: 'COMPANY_REGISTERED',
        targetType: 'company',
        targetId: companyId,
        outcome: 'success',
        details: `Registered ${cName} and Company Admin ${aUsername} (${employeeId})`,
        ipAddress: ip,
      });

      const session = createSession(db, {
        userId,
        companyId,
        ipAddress: ip,
        userAgent: req.headers['user-agent'],
      });
      setSessionCookie(res, session.rawToken, session.expiresAt);

      res.status(201).json({
        token: session.rawToken,
        expiresAt: session.expiresAt,
        requiresPasswordChange: false,
        user: {
          userId,
          username: aUsername,
          fullName: aName,
          email: aEmail,
          role: 'Company Admin',
          companyId,
          companyName: cName,
          employeeRecordId: empRecordId,
          employeeId,
          mustChangePassword: false,
        },
      });
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // ignore rollback error
      }
      const message = err instanceof Error ? err.message : 'Company registration failed.';
      res.status(400).json({ error: message });
    }
  });

  router.post('/change-first-password', authenticateSession(db), (req: AuthenticatedRequest, res) => {
    const auth = req.auth!;
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    const confirmPassword = String(req.body?.confirmPassword || '');

    if (!currentPassword || !newPassword || !confirmPassword) {
      res.status(400).json({ error: 'All password fields are required.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      res.status(400).json({ error: 'New password and confirmation do not match.' });
      return;
    }
    if (currentPassword === newPassword) {
      res.status(400).json({ error: 'New password must be different from your temporary password.' });
      return;
    }
    const pwdErr = validatePasswordStrength(newPassword);
    if (pwdErr) {
      res.status(400).json({ error: pwdErr });
      return;
    }

    const userRow = db
      .prepare('SELECT password_hash FROM users WHERE user_id = ?')
      .get(auth.userId) as { password_hash: string } | undefined;

    if (!userRow || !verifyPassword(currentPassword, userRow.password_hash)) {
      res.status(400).json({ error: 'Current temporary password is incorrect.' });
      return;
    }

    const nextHash = hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE user_id = ?').run(
      nextHash,
      auth.userId
    );

    recordAuditLog(db, {
      companyId: auth.companyId,
      actorUserId: auth.userId,
      actorUsername: auth.username,
      action: 'FIRST_LOGIN_PASSWORD_CHANGED',
      targetType: 'user',
      targetId: auth.userId,
      outcome: 'success',
      details: 'User updated temporary password and unlocked full workspace access.',
      ipAddress: getClientIp(req),
    });

    res.json({ ok: true, mustChangePassword: false });
  });

  router.post('/forgot-password', (req, res) => {
    const identifier = String(req.body?.identifier || '').trim();
    if (!identifier) {
      res.status(400).json({ error: 'Enter your registered email address or username.' });
      return;
    }

    const userRow = db
      .prepare(`
        SELECT u.user_id, u.username, u.email, u.company_id, u.account_status, c.status AS company_status
        FROM users u
        LEFT JOIN companies c ON c.company_id = u.company_id
        WHERE u.username = ? COLLATE NOCASE OR u.email = ? COLLATE NOCASE
        LIMIT 1
      `)
      .get(identifier, identifier) as
      | {
          user_id: string;
          username: string;
          email: string;
          company_id: string | null;
          account_status: string;
          company_status: string | null;
        }
      | undefined;

    if (userRow && userRow.account_status === 'active' && (!userRow.company_id || userRow.company_status === 'active')) {
      const rawCode = generateRandomToken(4).toUpperCase();
      const tokenHash = sha256(rawCode);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

      db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(
        now.toISOString(),
        userRow.user_id
      );

      db.prepare(`
        INSERT INTO password_reset_tokens (token_id, user_id, token_hash, expires_at, used_at, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)
      `).run(generateId('prt'), userRow.user_id, tokenHash, expiresAt, now.toISOString());

      db.prepare(`
        INSERT INTO sandbox_outbox (id, recipient_email, subject, reset_code, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(generateId('mail'), userRow.email, 'SmartAttend Password Reset Verification', rawCode, now.toISOString());

      recordAuditLog(db, {
        companyId: userRow.company_id,
        actorUserId: userRow.user_id,
        actorUsername: userRow.username,
        action: 'PASSWORD_RESET_REQUESTED',
        targetType: 'user',
        targetId: userRow.user_id,
        outcome: 'success',
        details: 'Single-use password reset token generated.',
        ipAddress: getClientIp(req),
      });
    }

    // Strict non-enumerating response: never reveal account or company existence
    res.json({
      ok: true,
      message:
        'If an active account matches that username or email, a single-use verification code has been dispatched.',
    });
  });

  router.get('/sandbox-outbox', (_req, res) => {
    const rows = db
      .prepare('SELECT id, recipient_email, subject, reset_code, created_at FROM sandbox_outbox ORDER BY created_at DESC LIMIT 8')
      .all();
    res.json({ messages: rows });
  });

  router.post('/reset-password', (req, res) => {
    const token = String(req.body?.token || '').trim().toUpperCase();
    const newPassword = String(req.body?.newPassword || '');
    const confirmPassword = String(req.body?.confirmPassword || '');

    if (!token || !newPassword || !confirmPassword) {
      res.status(400).json({ error: 'Verification code and new password fields are required.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      res.status(400).json({ error: 'Passwords do not match.' });
      return;
    }
    const pwdErr = validatePasswordStrength(newPassword);
    if (pwdErr) {
      res.status(400).json({ error: pwdErr });
      return;
    }

    const tokenHash = sha256(token);
    const tokenRow = db
      .prepare(`
        SELECT prt.token_id, prt.user_id, prt.expires_at, prt.used_at, u.username, u.company_id
        FROM password_reset_tokens prt
        JOIN users u ON u.user_id = prt.user_id
        WHERE prt.token_hash = ?
      `)
      .get(tokenHash) as
      | {
          token_id: string;
          user_id: string;
          expires_at: string;
          used_at: string | null;
          username: string;
          company_id: string | null;
        }
      | undefined;

    if (!tokenRow || tokenRow.used_at || Date.parse(tokenRow.expires_at) <= Date.now()) {
      res.status(400).json({ error: 'Invalid, expired, or already used verification code.' });
      return;
    }

    const now = new Date().toISOString();
    const nextHash = hashPassword(newPassword);

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE user_id = ?').run(
        nextHash,
        tokenRow.user_id
      );
      db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token_id = ?').run(now, tokenRow.token_id);
      revokeAllUserSessions(db, tokenRow.user_id);
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    recordAuditLog(db, {
      companyId: tokenRow.company_id,
      actorUserId: tokenRow.user_id,
      actorUsername: tokenRow.username,
      action: 'PASSWORD_RESET_COMPLETED',
      targetType: 'user',
      targetId: tokenRow.user_id,
      outcome: 'success',
      details: 'Password reset completed; token invalidated and existing sessions terminated.',
      ipAddress: getClientIp(req),
    });

    res.json({ ok: true, message: 'Password updated successfully. You may now sign in with your new password.' });
  });

  return router;
}
