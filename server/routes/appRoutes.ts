import { Router } from 'express';
import type { ServerDatabase } from '../postgres.ts';
import {
  authenticateSession,
  generateId,
  generateNextEmployeeId,
  generateSecureTempPassword,
  getClientIp,
  hashPassword,
  haversineDistanceMeters,
  isIdentifierTaken,
  recordAuditLog,
  requirePasswordChanged,
  requireRoles,
  revokeAllCompanySessions,
  revokeAllUserSessions,
  validatePasswordStrength,
  validateUsernameFormat,
  type AuthenticatedRequest,
} from '../auth.ts';

const ADMIN_ROLES = ['Company Admin', 'HR'];
const APPROVER_ROLES = ['Company Admin', 'HR', 'HOD', 'Manager', 'Responsible Person'];

export function createAppRouter(db: ServerDatabase): Router {
  const router = Router();

  // Every route in /api/* (except /api/auth/* and /api/health) requires a valid session AND completed password change.
  router.use(authenticateSession(db));
  router.use(requirePasswordChanged);

  function assertCompanyContext(req: AuthenticatedRequest, res: import('express').Response): string | null {
    const companyId = req.auth?.companyId;
    if (!companyId) {
      res.status(400).json({ error: 'Company context is required for this module.' });
      return null;
    }
    return companyId;
  }

  function blockCrossCompanyAttempt(
    req: AuthenticatedRequest,
    res: import('express').Response,
    targetCompanyId: string | undefined,
    targetType: string,
    targetId: string
  ): boolean {
    if (!targetCompanyId) {
      res.status(404).json({ error: `${targetType} not found.` });
      return true;
    }
    if (req.auth!.role !== 'Super Admin' && targetCompanyId !== req.auth!.companyId) {
      recordAuditLog(db, {
        companyId: req.auth!.companyId,
        actorUserId: req.auth!.userId,
        actorUsername: req.auth!.username,
        action: 'CROSS_TENANT_ACCESS_DENIED',
        targetType,
        targetId,
        outcome: 'denied',
        details: `Blocked access attempt from ${req.auth!.companyId} to ${targetCompanyId}`,
        ipAddress: getClientIp(req),
      });
      res.status(403).json({
        error: 'Cross-company access is strictly prohibited.',
        code: 'CROSS_TENANT_FORBIDDEN',
      });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 1. ROLE-BASED DASHBOARD
  // ---------------------------------------------------------------------------
  router.get('/dashboard', (req: AuthenticatedRequest, res) => {
    const auth = req.auth!;
    const today = new Date().toISOString().slice(0, 10);

    if (auth.role === 'Super Admin') {
      const companies = db
        .prepare(`
          SELECT c.*,
            (SELECT COUNT(*) FROM employees e WHERE e.company_id = c.company_id) AS employee_count,
            (SELECT COUNT(*) FROM users u WHERE u.company_id = c.company_id AND u.account_status = 'active') AS active_users
          FROM companies c
          ORDER BY c.created_at DESC
        `)
        .all();
      const totals = db
        .prepare(`
          SELECT
            (SELECT COUNT(*) FROM companies) AS total_companies,
            (SELECT COUNT(*) FROM companies WHERE status = 'active') AS active_companies,
            (SELECT COUNT(*) FROM users) AS total_users,
            (SELECT COUNT(*) FROM employees) AS total_employees
        `)
        .get();
      res.json({ mode: 'super_admin', totals, companies });
      return;
    }

    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const headcount = db
      .prepare(`
        SELECT
          COUNT(*) AS total_employees,
          SUM(CASE WHEN employment_status = 'active' THEN 1 ELSE 0 END) AS active_employees
        FROM employees WHERE company_id = ?
      `)
      .get(companyId) as { total_employees: number; active_employees: number };

    const todayAttendance = db
      .prepare(`
        SELECT
          COUNT(*) AS checked_in_count,
          SUM(CASE WHEN is_late = 1 THEN 1 ELSE 0 END) AS late_count,
          SUM(CASE WHEN status = 'WFH' THEN 1 ELSE 0 END) AS wfh_count
        FROM attendance_records
        WHERE company_id = ? AND attendance_date = ?
      `)
      .get(companyId, today) as { checked_in_count: number; late_count: number; wfh_count: number };

    const pendingApprovals = db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM leave_applications WHERE company_id = ? AND status LIKE 'Pending%') AS pending_leaves,
          (SELECT COUNT(*) FROM regularization_requests WHERE company_id = ? AND status = 'Pending') AS pending_regs,
          (SELECT COUNT(*) FROM wfh_requests WHERE company_id = ? AND status = 'Pending') AS pending_wfh
      `)
      .get(companyId, companyId, companyId) as {
      pending_leaves: number;
      pending_regs: number;
      pending_wfh: number;
    };

    const deptBreakdown = db
      .prepare(`
        SELECT d.name AS department, COUNT(e.employee_record_id) AS count
        FROM departments d
        LEFT JOIN employees e ON e.department_id = d.department_id AND e.company_id = d.company_id
        WHERE d.company_id = ?
        GROUP BY d.department_id
        ORDER BY COUNT(e.employee_record_id) DESC
      `)
      .all(companyId);

    const upcomingHolidays = db
      .prepare(`
        SELECT holiday_id, name, holiday_date, holiday_type
        FROM holidays
        WHERE company_id = ? AND holiday_date >= ?
        ORDER BY holiday_date ASC LIMIT 5
      `)
      .all(companyId, today);

    const myToday = auth.employeeRecordId
      ? db
          .prepare('SELECT * FROM attendance_records WHERE company_id = ? AND employee_record_id = ? AND attendance_date = ?')
          .get(companyId, auth.employeeRecordId, today)
      : null;

    const myBalances = auth.employeeRecordId
      ? db
          .prepare('SELECT leave_type, total_days, used_days FROM leave_balances WHERE company_id = ? AND employee_record_id = ? AND year = 2026')
          .all(companyId, auth.employeeRecordId)
      : [];

    const recentAttendance = db
      .prepare(`
        SELECT a.attendance_id, a.attendance_date, a.check_in_time, a.check_out_time, a.working_hours,
               a.status, a.geofence_status, a.is_late, a.late_minutes,
               e.employee_name, e.employee_id, d.name AS department_name
        FROM attendance_records a
        JOIN employees e ON e.employee_record_id = a.employee_record_id
        LEFT JOIN departments d ON d.department_id = e.department_id
        WHERE a.company_id = ?
        ORDER BY a.attendance_date DESC, a.check_in_time DESC
        LIMIT 8
      `)
      .all(companyId);

    res.json({
      mode: 'company',
      companyId,
      headcount,
      todayAttendance,
      pendingApprovals,
      deptBreakdown,
      upcomingHolidays,
      myToday,
      myBalances,
      recentAttendance,
    });
  });

  // ---------------------------------------------------------------------------
  // 2. ORGANIZATION OPTIONS (Departments, Locations, Shifts, Holidays, Settings)
  // ---------------------------------------------------------------------------
  router.get('/org-options', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const departments = db.prepare('SELECT * FROM departments WHERE company_id = ? ORDER BY name').all(companyId);
    const locations = db.prepare('SELECT * FROM office_locations WHERE company_id = ? ORDER BY name').all(companyId);
    const shifts = db.prepare('SELECT * FROM shifts WHERE company_id = ? ORDER BY name').all(companyId);
    const holidays = db.prepare('SELECT * FROM holidays WHERE company_id = ? ORDER BY holiday_date').all(companyId);
    const settings = db.prepare('SELECT * FROM company_settings WHERE company_id = ?').get(companyId);
    const managers = db
      .prepare(`
        SELECT e.employee_record_id, e.employee_id, e.employee_name, r.role_name
        FROM employees e
        JOIN users u ON u.user_id = e.user_id
        JOIN roles r ON r.role_id = u.role_id
        WHERE e.company_id = ? AND u.account_status = 'active'
          AND r.role_name IN ('Company Admin', 'HR', 'HOD', 'Manager', 'Responsible Person')
        ORDER BY e.employee_name
      `)
      .all(companyId);

    res.json({ departments, locations, shifts, holidays, settings, managers });
  });

  router.post('/locations', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const { name, address, latitude, longitude, radiusMeters } = req.body || {};
    if (!name || !address || latitude === undefined || longitude === undefined) {
      res.status(400).json({ error: 'Location name, address, latitude, and longitude are required.' });
      return;
    }
    const id = generateId('loc');
    db.prepare(`
      INSERT INTO office_locations (location_id, company_id, name, address, latitude, longitude, radius_meters, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(id, companyId, String(name).trim(), String(address).trim(), Number(latitude), Number(longitude), Number(radiusMeters) || 250);
    res.status(201).json({ locationId: id });
  });

  router.post('/shifts', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const { name, startTime, endTime, graceMinutes, breakMinutes } = req.body || {};
    if (!name || !startTime || !endTime) {
      res.status(400).json({ error: 'Shift name, start time, and end time are required.' });
      return;
    }
    const id = generateId('shift');
    db.prepare(`
      INSERT INTO shifts (shift_id, company_id, name, start_time, end_time, grace_minutes, break_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, companyId, String(name).trim(), String(startTime), String(endTime), Number(graceMinutes ?? 15), Number(breakMinutes ?? 60));
    res.status(201).json({ shiftId: id });
  });

  router.post('/departments', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const { name, code } = req.body || {};
    if (!name || !code) {
      res.status(400).json({ error: 'Department name and code are required.' });
      return;
    }
    const id = generateId('dept');
    db.prepare('INSERT INTO departments (department_id, company_id, name, code) VALUES (?, ?, ?, ?)').run(
      id,
      companyId,
      String(name).trim(),
      String(code).trim().toUpperCase()
    );
    res.status(201).json({ departmentId: id });
  });

  router.post('/holidays', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const { name, holidayDate, holidayType } = req.body || {};
    if (!name || !holidayDate) {
      res.status(400).json({ error: 'Holiday name and date are required.' });
      return;
    }
    const id = generateId('hol');
    db.prepare('INSERT INTO holidays (holiday_id, company_id, name, holiday_date, holiday_type) VALUES (?, ?, ?, ?, ?)').run(
      id,
      companyId,
      String(name).trim(),
      String(holidayDate),
      String(holidayType || 'Public')
    );
    res.status(201).json({ holidayId: id });
  });

  router.patch('/settings', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const { gracePeriodMinutes, halfDayHours, fullDayHours, workweekDays, requireGeofence, supportEmail, supportPhone } =
      req.body || {};
    db.prepare(`
      UPDATE company_settings
      SET grace_period_minutes = COALESCE(?, grace_period_minutes),
          half_day_hours = COALESCE(?, half_day_hours),
          full_day_hours = COALESCE(?, full_day_hours),
          workweek_days = COALESCE(?, workweek_days),
          require_geofence = COALESCE(?, require_geofence),
          support_email = COALESCE(?, support_email),
          support_phone = COALESCE(?, support_phone)
      WHERE company_id = ?
    `).run(
      gracePeriodMinutes !== undefined ? Number(gracePeriodMinutes) : null,
      halfDayHours !== undefined ? Number(halfDayHours) : null,
      fullDayHours !== undefined ? Number(fullDayHours) : null,
      workweekDays ?? null,
      requireGeofence !== undefined ? (requireGeofence ? 1 : 0) : null,
      supportEmail ?? null,
      supportPhone ?? null,
      companyId
    );
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // 3. EMPLOYEE MANAGEMENT (Admin/HR creates accounts; never exposes passwords)
  // ---------------------------------------------------------------------------
  router.get('/employees', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    // Never select password_hash!
    const rows = db
      .prepare(`
        SELECT
          e.employee_record_id, e.employee_id, e.user_id, e.company_id,
          e.employee_name, e.email, e.mobile, e.department_id, e.designation,
          e.reporting_manager_id, e.hod_id, e.joining_date, e.employment_type,
          e.office_location_id, e.assigned_shift_id, e.employment_status, e.profile_picture, e.created_at,
          u.username, u.account_status, u.must_change_password,
          r.role_name,
          d.name AS department_name,
          l.name AS location_name,
          s.name AS shift_name,
          mgr.employee_name AS reporting_manager_name,
          hod.employee_name AS hod_name
        FROM employees e
        JOIN users u ON u.user_id = e.user_id
        JOIN roles r ON r.role_id = u.role_id
        LEFT JOIN departments d ON d.department_id = e.department_id
        LEFT JOIN office_locations l ON l.location_id = e.office_location_id
        LEFT JOIN shifts s ON s.shift_id = e.assigned_shift_id
        LEFT JOIN employees mgr ON mgr.employee_record_id = e.reporting_manager_id
        LEFT JOIN employees hod ON hod.employee_record_id = e.hod_id
        WHERE e.company_id = ?
        ORDER BY e.employee_id ASC
      `)
      .all(companyId);

    res.json({ employees: rows });
  });

  router.get('/employees/:employeeRecordId', (req: AuthenticatedRequest, res) => {
    const row = db
      .prepare(`
        SELECT
          e.employee_record_id, e.employee_id, e.user_id, e.company_id,
          e.employee_name, e.email, e.mobile, e.department_id, e.designation,
          e.reporting_manager_id, e.hod_id, e.joining_date, e.employment_type,
          e.office_location_id, e.assigned_shift_id, e.employment_status, e.profile_picture,
          u.username, u.account_status, u.must_change_password, r.role_name
        FROM employees e
        JOIN users u ON u.user_id = e.user_id
        JOIN roles r ON r.role_id = u.role_id
        WHERE e.employee_record_id = ?
      `)
      .get(req.params.employeeRecordId) as { company_id: string } | undefined;

    if (blockCrossCompanyAttempt(req, res, row?.company_id, 'employee', req.params.employeeRecordId)) return;
    res.json({ employee: row });
  });

  router.post('/employees/generate-password', requireRoles(...ADMIN_ROLES), (_req, res) => {
    res.json({ password: generateSecureTempPassword() });
  });

  router.post('/employees', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const {
      employeeName,
      email,
      mobile,
      departmentId,
      designation,
      reportingManagerId,
      hodId,
      joiningDate,
      employmentType,
      officeLocationId,
      assignedShiftId,
      employmentStatus,
      profilePicture,
      roleName,
      username,
      password,
      confirmPassword,
      forcePasswordChange,
    } = req.body || {};

    const eName = String(employeeName || '').trim();
    const eEmail = String(email || '').trim().toLowerCase();
    const eMobile = String(mobile || '').trim();
    const eDesignation = String(designation || '').trim();
    const eJoinDate = String(joiningDate || new Date().toISOString().slice(0, 10));
    const eUsername = String(username || '').trim();
    const ePassword = String(password || '');
    const eConfirm = String(confirmPassword || '');

    if (!eName || !eEmail || !eMobile || !eDesignation || !eUsername || !ePassword) {
      res.status(400).json({
        error: 'Employee Name, Email, Mobile, Designation, Username, and Password are required.',
      });
      return;
    }
    if (ePassword !== eConfirm) {
      res.status(400).json({ error: 'Password and Confirm Password do not match.' });
      return;
    }

    const usernameErr = validateUsernameFormat(eUsername);
    if (usernameErr) {
      res.status(400).json({ error: usernameErr });
      return;
    }
    const pwdErr = validatePasswordStrength(ePassword);
    if (pwdErr) {
      res.status(400).json({ error: pwdErr });
      return;
    }

    const allowedEmployeeRoles = ['Employee', 'HR', 'HOD', 'Manager', 'Responsible Person'];
    const targetRole = allowedEmployeeRoles.includes(String(roleName)) ? String(roleName) : 'Employee';
    const roleRow = db.prepare('SELECT role_id FROM roles WHERE role_name = ?').get(targetRole) as
      | { role_id: string }
      | undefined;
    if (!roleRow) {
      res.status(400).json({ error: 'Invalid role selection.' });
      return;
    }

    // Verify optional foreign keys belong to THIS company
    if (departmentId) {
      const d = db
        .prepare('SELECT company_id FROM departments WHERE department_id = ?')
        .get(departmentId) as { company_id: string } | undefined;
      if (!d || d.company_id !== companyId) {
        res.status(400).json({ error: 'Invalid department for your company.' });
        return;
      }
    }
    if (officeLocationId) {
      const l = db
        .prepare('SELECT company_id FROM office_locations WHERE location_id = ?')
        .get(officeLocationId) as { company_id: string } | undefined;
      if (!l || l.company_id !== companyId) {
        res.status(400).json({ error: 'Invalid office location for your company.' });
        return;
      }
    }
    if (assignedShiftId) {
      const s = db
        .prepare('SELECT company_id FROM shifts WHERE shift_id = ?')
        .get(assignedShiftId) as { company_id: string } | undefined;
      if (!s || s.company_id !== companyId) {
        res.status(400).json({ error: 'Invalid shift for your company.' });
        return;
      }
    }

    const now = new Date().toISOString();
    const userId = generateId('usr');
    const employeeRecordId = generateId('rec');
    const passHash = hashPassword(ePassword);
    const mustChange = forcePasswordChange === false ? 0 : 1;
    const empStatus = ['active', 'on_leave', 'inactive'].includes(String(employmentStatus))
      ? String(employmentStatus)
      : 'active';
    const acctStatus = empStatus === 'inactive' ? 'inactive' : 'active';

    db.exec('BEGIN IMMEDIATE;');
    try {
      if (isIdentifierTaken(db, eUsername)) {
        db.exec('ROLLBACK;');
        res.status(409).json({
          error: 'Username is already taken in SmartAttend. Usernames must be globally unique across all companies.',
          code: 'USERNAME_TAKEN',
        });
        return;
      }

      const generatedEmployeeId = generateNextEmployeeId(db, eUsername);

      db.prepare(`
        INSERT INTO users (user_id, username, password_hash, email, mobile, full_name, company_id, role_id, account_status, must_change_password, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(userId, eUsername, passHash, eEmail, eMobile, eName, companyId, roleRow.role_id, acctStatus, mustChange, now);

      db.prepare('INSERT INTO login_identifiers (identifier, user_id, kind, created_at) VALUES (?, ?, ?, ?)').run(
        eUsername,
        userId,
        'username',
        now
      );

      db.prepare(`
        INSERT INTO employees (
          employee_record_id, employee_id, user_id, company_id, employee_name, email, mobile,
          department_id, designation, reporting_manager_id, hod_id, joining_date, employment_type,
          office_location_id, assigned_shift_id, employment_status, profile_picture, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        employeeRecordId,
        generatedEmployeeId,
        userId,
        companyId,
        eName,
        eEmail,
        eMobile,
        departmentId || null,
        eDesignation,
        reportingManagerId || null,
        hodId || null,
        eJoinDate,
        String(employmentType || 'Full-Time'),
        officeLocationId || null,
        assignedShiftId || null,
        empStatus,
        profilePicture ? String(profilePicture).trim() : null,
        now
      );

      db.prepare('INSERT INTO login_identifiers (identifier, user_id, kind, created_at) VALUES (?, ?, ?, ?)').run(
        generatedEmployeeId,
        userId,
        'employee_id',
        now
      );

      const balStmt = db.prepare(`
        INSERT INTO leave_balances (balance_id, company_id, employee_record_id, leave_type, total_days, used_days, year)
        VALUES (?, ?, ?, ?, ?, 0, 2026)
      `);
      balStmt.run(generateId('bal'), companyId, employeeRecordId, 'Annual Leave', 18);
      balStmt.run(generateId('bal'), companyId, employeeRecordId, 'Sick Leave', 10);
      balStmt.run(generateId('bal'), companyId, employeeRecordId, 'Casual Leave', 6);

      db.prepare(`
        INSERT INTO notifications (notification_id, company_id, user_id, title, message, category, is_read, created_at)
        VALUES (?, ?, ?, 'Account Created', ?, 'System', 0, ?)
      `).run(
        generateId('ntf'),
        companyId,
        userId,
        `Welcome to SmartAttend! Your Employee ID is ${generatedEmployeeId}.`,
        now
      );

      db.exec('COMMIT;');

      recordAuditLog(db, {
        companyId,
        actorUserId: req.auth!.userId,
        actorUsername: req.auth!.username,
        action: 'EMPLOYEE_CREATED',
        targetType: 'employee',
        targetId: generatedEmployeeId,
        outcome: 'success',
        details: `Created employee ${eName} with username ${eUsername} and generated ID ${generatedEmployeeId}`,
        ipAddress: getClientIp(req),
      });

      res.status(201).json({
        employee: {
          employeeRecordId,
          employeeId: generatedEmployeeId,
          userId,
          username: eUsername,
          employeeName: eName,
          email: eEmail,
          designation: eDesignation,
          role: targetRole,
          mustChangePassword: Boolean(mustChange),
        },
      });
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // ignore
      }
      const msg = err instanceof Error ? err.message : 'Unable to create employee account.';
      res.status(400).json({ error: msg });
    }
  });

  router.patch('/employees/:employeeRecordId', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const existing = db
      .prepare('SELECT employee_record_id, user_id, company_id, employee_id FROM employees WHERE employee_record_id = ?')
      .get(req.params.employeeRecordId) as
      | { employee_record_id: string; user_id: string; company_id: string; employee_id: string }
      | undefined;

    if (blockCrossCompanyAttempt(req, res, existing?.company_id, 'employee', req.params.employeeRecordId)) return;

    const {
      employeeName,
      email,
      mobile,
      departmentId,
      designation,
      reportingManagerId,
      hodId,
      employmentType,
      officeLocationId,
      assignedShiftId,
      employmentStatus,
      roleName,
    } = req.body || {};

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(`
        UPDATE employees
        SET employee_name = COALESCE(?, employee_name),
            email = COALESCE(?, email),
            mobile = COALESCE(?, mobile),
            department_id = COALESCE(?, department_id),
            designation = COALESCE(?, designation),
            reporting_manager_id = ?,
            hod_id = ?,
            employment_type = COALESCE(?, employment_type),
            office_location_id = COALESCE(?, office_location_id),
            assigned_shift_id = COALESCE(?, assigned_shift_id),
            employment_status = COALESCE(?, employment_status)
        WHERE employee_record_id = ? AND company_id = ?
      `).run(
        employeeName ? String(employeeName).trim() : null,
        email ? String(email).trim().toLowerCase() : null,
        mobile ? String(mobile).trim() : null,
        departmentId || null,
        designation ? String(designation).trim() : null,
        reportingManagerId ?? null,
        hodId ?? null,
        employmentType ?? null,
        officeLocationId || null,
        assignedShiftId || null,
        employmentStatus ?? null,
        existing!.employee_record_id,
        existing!.company_id
      );

      if (employeeName || email || mobile) {
        db.prepare(`
          UPDATE users
          SET full_name = COALESCE(?, full_name),
              email = COALESCE(?, email),
              mobile = COALESCE(?, mobile)
          WHERE user_id = ?
        `).run(
          employeeName ? String(employeeName).trim() : null,
          email ? String(email).trim().toLowerCase() : null,
          mobile ? String(mobile).trim() : null,
          existing!.user_id
        );
      }

      if (roleName && ['Employee', 'HR', 'HOD', 'Manager', 'Responsible Person'].includes(String(roleName))) {
        const roleRow = db.prepare('SELECT role_id FROM roles WHERE role_name = ?').get(String(roleName)) as
          | { role_id: string }
          | undefined;
        if (roleRow) {
          db.prepare('UPDATE users SET role_id = ? WHERE user_id = ?').run(roleRow.role_id, existing!.user_id);
        }
      }

      db.exec('COMMIT;');
      recordAuditLog(db, {
        companyId: req.auth!.companyId,
        actorUserId: req.auth!.userId,
        actorUsername: req.auth!.username,
        action: 'EMPLOYEE_UPDATED',
        targetType: 'employee',
        targetId: existing!.employee_id,
        outcome: 'success',
        details: 'Updated employee profile and assignments.',
        ipAddress: getClientIp(req),
      });
      res.json({ ok: true });
    } catch (err) {
      db.exec('ROLLBACK;');
      res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed.' });
    }
  });

  router.post('/employees/:employeeRecordId/status', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const existing = db
      .prepare('SELECT employee_record_id, user_id, company_id, employee_id FROM employees WHERE employee_record_id = ?')
      .get(req.params.employeeRecordId) as
      | { employee_record_id: string; user_id: string; company_id: string; employee_id: string }
      | undefined;

    if (blockCrossCompanyAttempt(req, res, existing?.company_id, 'employee', req.params.employeeRecordId)) return;

    if (existing!.user_id === req.auth!.userId) {
      res.status(400).json({ error: 'You cannot deactivate your own currently signed-in administrator account.' });
      return;
    }

    const nextStatus = req.body?.status === 'inactive' ? 'inactive' : 'active';
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare('UPDATE users SET account_status = ? WHERE user_id = ?').run(nextStatus, existing!.user_id);
      db.prepare('UPDATE employees SET employment_status = ? WHERE employee_record_id = ?').run(
        nextStatus,
        existing!.employee_record_id
      );
      if (nextStatus === 'inactive') {
        revokeAllUserSessions(db, existing!.user_id);
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    recordAuditLog(db, {
      companyId: req.auth!.companyId,
      actorUserId: req.auth!.userId,
      actorUsername: req.auth!.username,
      action: nextStatus === 'inactive' ? 'EMPLOYEE_DEACTIVATED' : 'EMPLOYEE_REACTIVATED',
      targetType: 'employee',
      targetId: existing!.employee_id,
      outcome: 'success',
      details: `Account status changed to ${nextStatus}`,
      ipAddress: getClientIp(req),
    });

    res.json({ ok: true, status: nextStatus });
  });

  // ---------------------------------------------------------------------------
  // 4. GPS CHECK-IN / CHECK-OUT, GEOFENCING & ATTENDANCE
  // ---------------------------------------------------------------------------
  router.get('/attendance', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const scope = String(req.query.scope || 'all');
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));

    let sql = `
      SELECT a.*, e.employee_name, e.employee_id, d.name AS department_name, s.name AS shift_name
      FROM attendance_records a
      JOIN employees e ON e.employee_record_id = a.employee_record_id
      LEFT JOIN departments d ON d.department_id = e.department_id
      LEFT JOIN shifts s ON s.shift_id = a.shift_id
      WHERE a.company_id = ? AND a.attendance_date LIKE ?
    `;
    const params: Array<string> = [companyId, `${month}%`];

    if (scope === 'mine' || !APPROVER_ROLES.includes(req.auth!.role)) {
      if (req.auth!.employeeRecordId) {
        sql += ' AND a.employee_record_id = ?';
        params.push(req.auth!.employeeRecordId);
      }
    }

    sql += ' ORDER BY a.attendance_date DESC, a.check_in_time DESC';
    const records = db.prepare(sql).all(...params);

    let assignedLocation = null;
    let assignedShift = null;
    if (req.auth!.employeeRecordId) {
      const emp = db
        .prepare('SELECT office_location_id, assigned_shift_id FROM employees WHERE employee_record_id = ? AND company_id = ?')
        .get(req.auth!.employeeRecordId, companyId) as
        | { office_location_id: string | null; assigned_shift_id: string | null }
        | undefined;
      if (emp?.office_location_id) {
        assignedLocation = db
          .prepare('SELECT * FROM office_locations WHERE location_id = ? AND company_id = ?')
          .get(emp.office_location_id, companyId);
      }
      if (emp?.assigned_shift_id) {
        assignedShift = db
          .prepare('SELECT * FROM shifts WHERE shift_id = ? AND company_id = ?')
          .get(emp.assigned_shift_id, companyId);
      }
    }
    if (!assignedLocation) {
      assignedLocation = db
        .prepare('SELECT * FROM office_locations WHERE company_id = ? LIMIT 1')
        .get(companyId);
    }

    const gpsLogs = db
      .prepare(`
        SELECT g.*, e.employee_name, e.employee_id
        FROM gps_logs g
        JOIN employees e ON e.employee_record_id = g.employee_record_id
        WHERE g.company_id = ?
        ORDER BY g.recorded_at DESC LIMIT 20
      `)
      .all(companyId);

    res.json({ records, assignedLocation, assignedShift, gpsLogs });
  });

  router.post('/attendance/check-in', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    if (!req.auth!.employeeRecordId) {
      res.status(400).json({ error: 'Employee profile not linked to this account.' });
      return;
    }

    const emp = db
      .prepare(`
        SELECT e.*, l.latitude AS loc_lat, l.longitude AS loc_lng, l.radius_meters, l.name AS loc_name,
               s.start_time, s.grace_minutes, s.shift_id
        FROM employees e
        LEFT JOIN office_locations l ON l.location_id = e.office_location_id
        LEFT JOIN shifts s ON s.shift_id = e.assigned_shift_id
        WHERE e.employee_record_id = ? AND e.company_id = ?
      `)
      .get(req.auth!.employeeRecordId, companyId) as
      | {
          employee_record_id: string;
          loc_lat: number | null;
          loc_lng: number | null;
          radius_meters: number | null;
          loc_name: string | null;
          start_time: string | null;
          grace_minutes: number | null;
          shift_id: string | null;
        }
      | undefined;

    if (!emp) {
      res.status(404).json({ error: 'Employee record not found.' });
      return;
    }

    const settings = db
      .prepare('SELECT require_geofence, grace_period_minutes FROM company_settings WHERE company_id = ?')
      .get(companyId) as { require_geofence: number; grace_period_minutes: number } | undefined;

    const lat = Number(req.body?.latitude ?? emp.loc_lat ?? 37.7749);
    const lng = Number(req.body?.longitude ?? emp.loc_lng ?? -122.4194);
    const notes = req.body?.notes ? String(req.body.notes).trim() : null;

    let distance = 0;
    let withinGeofence = 1;
    let geofenceStatus = 'Within Geofence';

    if (emp.loc_lat !== null && emp.loc_lng !== null) {
      distance = haversineDistanceMeters(lat, lng, emp.loc_lat, emp.loc_lng);
      const radius = emp.radius_meters ?? 250;
      withinGeofence = distance <= radius ? 1 : 0;
      geofenceStatus = withinGeofence ? `Within Geofence (${distance}m)` : `Outside Geofence (${distance}m > ${radius}m)`;

      if (settings?.require_geofence && !withinGeofence && !req.body?.allowRemoteOverride) {
        db.prepare(`
          INSERT INTO gps_logs (gps_id, company_id, employee_record_id, attendance_id, event_type, latitude, longitude, distance_meters, within_geofence, recorded_at)
          VALUES (?, ?, ?, NULL, 'Check-In Blocked', ?, ?, ?, 0, ?)
        `).run(generateId('gps'), companyId, emp.employee_record_id, lat, lng, distance, new Date().toISOString());

        res.status(400).json({
          error: `You are ${distance}m away from ${emp.loc_name || 'assigned office'} (allowed radius: ${radius}m). Move inside the geofence or submit a WFH request.`,
          code: 'OUTSIDE_GEOFENCE',
          distance,
          radius,
        });
        return;
      }
    }

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const existing = db
      .prepare('SELECT attendance_id FROM attendance_records WHERE employee_record_id = ? AND attendance_date = ?')
      .get(emp.employee_record_id, today);

    if (existing) {
      res.status(409).json({ error: 'You have already checked in today.' });
      return;
    }

    // Late arrival detection against shift start_time + grace
    const shiftStart = emp.start_time || '09:00';
    const grace = emp.grace_minutes ?? settings?.grace_period_minutes ?? 15;
    const [sh, sm] = shiftStart.split(':').map(Number);
    const shiftMinutes = sh * 60 + sm;
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const diff = currentMinutes - shiftMinutes;
    const isLate = diff > grace ? 1 : 0;
    const lateMinutes = isLate ? diff : 0;

    const attId = generateId('att');
    const nowIso = now.toISOString();

    db.prepare(`
      INSERT INTO attendance_records (
        attendance_id, company_id, employee_record_id, attendance_date, shift_id,
        check_in_time, check_in_lat, check_in_lng, distance_meters, geofence_status,
        break_minutes, working_hours, is_late, late_minutes, is_half_day, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, ?)
    `).run(
      attId,
      companyId,
      emp.employee_record_id,
      today,
      emp.shift_id,
      nowIso,
      lat,
      lng,
      distance,
      geofenceStatus,
      isLate,
      lateMinutes,
      isLate ? 'Late (Checked In)' : 'Checked In',
      notes
    );

    db.prepare(`
      INSERT INTO gps_logs (gps_id, company_id, employee_record_id, attendance_id, event_type, latitude, longitude, distance_meters, within_geofence, recorded_at)
      VALUES (?, ?, ?, ?, 'Check-In', ?, ?, ?, ?, ?)
    `).run(generateId('gps'), companyId, emp.employee_record_id, attId, lat, lng, distance, withinGeofence, nowIso);

    res.status(201).json({ attendanceId: attId, isLate: Boolean(isLate), lateMinutes, geofenceStatus });
  });

  router.post('/attendance/break', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId || !req.auth!.employeeRecordId) return;

    const today = new Date().toISOString().slice(0, 10);
    const rec = db
      .prepare('SELECT * FROM attendance_records WHERE company_id = ? AND employee_record_id = ? AND attendance_date = ?')
      .get(companyId, req.auth!.employeeRecordId, today) as
      | { attendance_id: string; check_out_time: string | null; active_break_start: string | null; break_minutes: number }
      | undefined;

    if (!rec || rec.check_out_time) {
      res.status(400).json({ error: 'Active check-in required to toggle break.' });
      return;
    }

    const nowIso = new Date().toISOString();
    if (!rec.active_break_start) {
      db.prepare('UPDATE attendance_records SET active_break_start = ? WHERE attendance_id = ?').run(nowIso, rec.attendance_id);
      res.json({ onBreak: true, breakMinutes: rec.break_minutes });
    } else {
      const addedMins = Math.max(1, Math.round((Date.now() - Date.parse(rec.active_break_start)) / 60000));
      const totalBreak = rec.break_minutes + addedMins;
      db.prepare('UPDATE attendance_records SET active_break_start = NULL, break_minutes = ? WHERE attendance_id = ?').run(
        totalBreak,
        rec.attendance_id
      );
      res.json({ onBreak: false, breakMinutes: totalBreak });
    }
  });

  router.post('/attendance/check-out', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId || !req.auth!.employeeRecordId) return;

    const today = new Date().toISOString().slice(0, 10);
    const rec = db
      .prepare('SELECT * FROM attendance_records WHERE company_id = ? AND employee_record_id = ? AND attendance_date = ?')
      .get(companyId, req.auth!.employeeRecordId, today) as
      | {
          attendance_id: string;
          check_in_time: string;
          check_out_time: string | null;
          active_break_start: string | null;
          break_minutes: number;
          is_late: number;
          check_in_lat: number;
          check_in_lng: number;
        }
      | undefined;

    if (!rec) {
      res.status(400).json({ error: 'No check-in record found for today.' });
      return;
    }
    if (rec.check_out_time) {
      res.status(409).json({ error: 'You have already checked out today.' });
      return;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    let totalBreakMins = rec.break_minutes;
    if (rec.active_break_start) {
      totalBreakMins += Math.max(1, Math.round((now.getTime() - Date.parse(rec.active_break_start)) / 60000));
    }

    const elapsedHours = Math.max(0.1, (now.getTime() - Date.parse(rec.check_in_time)) / 3600000 - totalBreakMins / 60);
    const workingHours = Number(elapsedHours.toFixed(2));

    const settings = db
      .prepare('SELECT half_day_hours FROM company_settings WHERE company_id = ?')
      .get(companyId) as { half_day_hours: number } | undefined;
    const halfDayThreshold = settings?.half_day_hours ?? 4.5;
    const isHalfDay = workingHours < halfDayThreshold ? 1 : 0;
    const finalStatus = isHalfDay ? 'Half-Day' : rec.is_late ? 'Late' : 'Present';

    const lat = Number(req.body?.latitude ?? rec.check_in_lat ?? 37.7749);
    const lng = Number(req.body?.longitude ?? rec.check_in_lng ?? -122.4194);

    db.prepare(`
      UPDATE attendance_records
      SET check_out_time = ?, check_out_lat = ?, check_out_lng = ?,
          active_break_start = NULL, break_minutes = ?, working_hours = ?,
          is_half_day = ?, status = ?
      WHERE attendance_id = ? AND company_id = ?
    `).run(nowIso, lat, lng, totalBreakMins, workingHours, isHalfDay, finalStatus, rec.attendance_id, companyId);

    db.prepare(`
      INSERT INTO gps_logs (gps_id, company_id, employee_record_id, attendance_id, event_type, latitude, longitude, distance_meters, within_geofence, recorded_at)
      VALUES (?, ?, ?, ?, 'Check-Out', ?, ?, 0, 1, ?)
    `).run(generateId('gps'), companyId, req.auth!.employeeRecordId, rec.attendance_id, lat, lng, nowIso);

    res.json({ workingHours, isHalfDay: Boolean(isHalfDay), status: finalStatus });
  });

  // ---------------------------------------------------------------------------
  // 5. LEAVE MANAGEMENT (Advance, Paid/Unpaid, Half-Day, Multi-level Approval)
  // ---------------------------------------------------------------------------
  router.get('/leaves', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const balances = req.auth!.employeeRecordId
      ? db
          .prepare('SELECT * FROM leave_balances WHERE company_id = ? AND employee_record_id = ? AND year = 2026')
          .all(companyId, req.auth!.employeeRecordId)
      : [];

    const applications = db
      .prepare(`
        SELECT l.*, e.employee_name, e.employee_id, d.name AS department_name
        FROM leave_applications l
        JOIN employees e ON e.employee_record_id = l.employee_record_id
        LEFT JOIN departments d ON d.department_id = e.department_id
        WHERE l.company_id = ?
        ORDER BY l.created_at DESC
      `)
      .all(companyId);

    res.json({ balances, applications });
  });

  router.post('/leaves', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId || !req.auth!.employeeRecordId) return;

    const { leaveType, startDate, endDate, dayMode, reason } = req.body || {};
    if (!leaveType || !startDate || !endDate || !reason) {
      res.status(400).json({ error: 'Leave type, start date, end date, and reason are required.' });
      return;
    }

    const startMs = Date.parse(String(startDate));
    const endMs = Date.parse(String(endDate));
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
      res.status(400).json({ error: 'End date must be on or after start date.' });
      return;
    }

    const mode = String(dayMode || 'Full Day');
    const rawDays = Math.floor((endMs - startMs) / 86400000) + 1;
    const daysCount = mode === 'Half Day' || mode === 'Early Leave' ? 0.5 : rawDays;

    // Paid vs Unpaid calculation against leave balance
    let isPaid = leaveType === 'Unpaid Leave (LOP)' ? 0 : 1;
    if (isPaid) {
      const bal = db
        .prepare('SELECT total_days, used_days FROM leave_balances WHERE company_id = ? AND employee_record_id = ? AND leave_type = ? AND year = 2026')
        .get(companyId, req.auth!.employeeRecordId, String(leaveType)) as
        | { total_days: number; used_days: number }
        | undefined;
      if (!bal || bal.total_days - bal.used_days < daysCount) {
        isPaid = 0; // Automatically converted to unpaid if balance insufficient
      }
    }

    const emp = db
      .prepare('SELECT reporting_manager_id, hod_id FROM employees WHERE employee_record_id = ? AND company_id = ?')
      .get(req.auth!.employeeRecordId, companyId) as
      | { reporting_manager_id: string | null; hod_id: string | null }
      | undefined;

    const leaveId = generateId('lv');
    const now = new Date().toISOString();
    const initialStatus = emp?.reporting_manager_id || emp?.hod_id ? 'Pending L1' : 'Pending L2';

    db.prepare(`
      INSERT INTO leave_applications (
        leave_id, company_id, employee_record_id, leave_type, start_date, end_date,
        days_count, day_mode, is_paid, reason, status, l1_approver_id, l1_status, l2_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?)
    `).run(
      leaveId,
      companyId,
      req.auth!.employeeRecordId,
      String(leaveType),
      String(startDate),
      String(endDate),
      daysCount,
      mode,
      isPaid,
      String(reason).trim(),
      initialStatus,
      emp?.reporting_manager_id || emp?.hod_id || null,
      initialStatus === 'Pending L2' ? 'Approved' : 'Pending',
      now
    );

    res.status(201).json({ leaveId, isPaid: Boolean(isPaid), daysCount, status: initialStatus });
  });

  router.post('/leaves/:leaveId/action', requireRoles(...APPROVER_ROLES), (req: AuthenticatedRequest, res) => {
    const leave = db
      .prepare('SELECT * FROM leave_applications WHERE leave_id = ?')
      .get(req.params.leaveId) as
      | {
          leave_id: string;
          company_id: string;
          employee_record_id: string;
          leave_type: string;
          days_count: number;
          is_paid: number;
          status: string;
        }
      | undefined;

    if (blockCrossCompanyAttempt(req, res, leave?.company_id, 'leave_application', req.params.leaveId)) return;

    const decision = req.body?.decision === 'reject' ? 'Rejected' : 'Approved';
    const comment = req.body?.comment ? String(req.body.comment).trim() : null;

    if (decision === 'Rejected') {
      db.prepare('UPDATE leave_applications SET status = ?, l1_comment = COALESCE(l1_comment, ?), l2_comment = ? WHERE leave_id = ?').run(
        'Rejected',
        comment,
        comment,
        leave!.leave_id
      );
      res.json({ ok: true, status: 'Rejected' });
      return;
    }

    // Multi-level approval: L1 (Manager/HOD/Responsible Person) -> L2 (HR/Company Admin)
    if (leave!.status === 'Pending L1' && !ADMIN_ROLES.includes(req.auth!.role)) {
      db.prepare('UPDATE leave_applications SET l1_status = ?, l1_comment = ?, status = ? WHERE leave_id = ?').run(
        'Approved',
        comment,
        'Pending L2',
        leave!.leave_id
      );
      res.json({ ok: true, status: 'Pending L2' });
      return;
    }

    // Final L2 approval (or direct Admin/HR approval)
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(`
        UPDATE leave_applications
        SET l1_status = 'Approved', l2_status = 'Approved', l2_approver_id = ?, l2_comment = ?, status = 'Approved'
        WHERE leave_id = ?
      `).run(req.auth!.employeeRecordId, comment, leave!.leave_id);

      if (leave!.is_paid === 1) {
        db.prepare(`
          UPDATE leave_balances
          SET used_days = used_days + ?
          WHERE company_id = ? AND employee_record_id = ? AND leave_type = ? AND year = 2026
        `).run(leave!.days_count, leave!.company_id, leave!.employee_record_id, leave!.leave_type);
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    res.json({ ok: true, status: 'Approved' });
  });

  // ---------------------------------------------------------------------------
  // 6. ATTENDANCE REGULARIZATION & WFH REQUESTS
  // ---------------------------------------------------------------------------
  router.get('/regularizations', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const rows = db
      .prepare(`
        SELECT r.*, e.employee_name, e.employee_id
        FROM regularization_requests r
        JOIN employees e ON e.employee_record_id = r.employee_record_id
        WHERE r.company_id = ?
        ORDER BY r.created_at DESC
      `)
      .all(companyId);
    res.json({ requests: rows });
  });

  router.post('/regularizations', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId || !req.auth!.employeeRecordId) return;
    const { attendanceDate, requestedCheckIn, requestedCheckOut, reason } = req.body || {};
    if (!attendanceDate || !requestedCheckIn || !requestedCheckOut || !reason) {
      res.status(400).json({ error: 'All regularization fields are required.' });
      return;
    }
    const regId = generateId('reg');
    db.prepare(`
      INSERT INTO regularization_requests (reg_id, company_id, employee_record_id, attendance_date, requested_check_in, requested_check_out, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?)
    `).run(regId, companyId, req.auth!.employeeRecordId, String(attendanceDate), String(requestedCheckIn), String(requestedCheckOut), String(reason).trim(), new Date().toISOString());
    res.status(201).json({ regId });
  });

  router.post('/regularizations/:regId/action', requireRoles(...APPROVER_ROLES), (req: AuthenticatedRequest, res) => {
    const reg = db
      .prepare('SELECT * FROM regularization_requests WHERE reg_id = ?')
      .get(req.params.regId) as
      | {
          reg_id: string;
          company_id: string;
          employee_record_id: string;
          attendance_date: string;
          requested_check_in: string;
          requested_check_out: string;
        }
      | undefined;

    if (blockCrossCompanyAttempt(req, res, reg?.company_id, 'regularization', req.params.regId)) return;

    const status = req.body?.decision === 'reject' ? 'Rejected' : 'Approved';
    db.prepare('UPDATE regularization_requests SET status = ?, reviewed_by = ?, review_comment = ? WHERE reg_id = ?').run(
      status,
      req.auth!.fullName,
      req.body?.comment || null,
      reg!.reg_id
    );

    if (status === 'Approved') {
      const checkInIso = `${reg!.attendance_date}T${reg!.requested_check_in}:00.000Z`;
      const checkOutIso = `${reg!.attendance_date}T${reg!.requested_check_out}:00.000Z`;
      const hours = Number(
        Math.max(0.5, (Date.parse(checkOutIso) - Date.parse(checkInIso)) / 3600000 - 1).toFixed(2)
      );
      const existingAtt = db
        .prepare('SELECT attendance_id FROM attendance_records WHERE company_id = ? AND employee_record_id = ? AND attendance_date = ?')
        .get(reg!.company_id, reg!.employee_record_id, reg!.attendance_date) as { attendance_id: string } | undefined;

      if (existingAtt) {
        db.prepare(`
          UPDATE attendance_records
          SET check_in_time = ?, check_out_time = ?, working_hours = ?, is_late = 0, late_minutes = 0, status = 'Present', notes = 'Regularized'
          WHERE attendance_id = ?
        `).run(checkInIso, checkOutIso, hours, existingAtt.attendance_id);
      } else {
        db.prepare(`
          INSERT INTO attendance_records (attendance_id, company_id, employee_record_id, attendance_date, check_in_time, check_out_time, geofence_status, working_hours, status, notes)
          VALUES (?, ?, ?, ?, ?, ?, 'Regularized', ?, 'Present', 'Regularized')
        `).run(generateId('att'), reg!.company_id, reg!.employee_record_id, reg!.attendance_date, checkInIso, checkOutIso, hours);
      }
    }

    res.json({ ok: true, status });
  });

  router.get('/wfh', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const rows = db
      .prepare(`
        SELECT w.*, e.employee_name, e.employee_id
        FROM wfh_requests w
        JOIN employees e ON e.employee_record_id = w.employee_record_id
        WHERE w.company_id = ?
        ORDER BY w.created_at DESC
      `)
      .all(companyId);
    res.json({ requests: rows });
  });

  router.post('/wfh', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId || !req.auth!.employeeRecordId) return;
    const { wfhDate, reason } = req.body || {};
    if (!wfhDate || !reason) {
      res.status(400).json({ error: 'WFH date and reason are required.' });
      return;
    }
    const wfhId = generateId('wfh');
    db.prepare(`
      INSERT INTO wfh_requests (wfh_id, company_id, employee_record_id, wfh_date, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'Pending', ?)
    `).run(wfhId, companyId, req.auth!.employeeRecordId, String(wfhDate), String(reason).trim(), new Date().toISOString());
    res.status(201).json({ wfhId });
  });

  router.post('/wfh/:wfhId/action', requireRoles(...APPROVER_ROLES), (req: AuthenticatedRequest, res) => {
    const wfh = db.prepare('SELECT * FROM wfh_requests WHERE wfh_id = ?').get(req.params.wfhId) as
      | { wfh_id: string; company_id: string; employee_record_id: string; wfh_date: string }
      | undefined;

    if (blockCrossCompanyAttempt(req, res, wfh?.company_id, 'wfh_request', req.params.wfhId)) return;

    const status = req.body?.decision === 'reject' ? 'Rejected' : 'Approved';
    db.prepare('UPDATE wfh_requests SET status = ?, reviewed_by = ?, review_comment = ? WHERE wfh_id = ?').run(
      status,
      req.auth!.fullName,
      req.body?.comment || null,
      wfh!.wfh_id
    );

    if (status === 'Approved') {
      db.prepare(`
        INSERT INTO attendance_records (attendance_id, company_id, employee_record_id, attendance_date, geofence_status, working_hours, status, notes)
        VALUES (?, ?, ?, ?, 'Remote WFH', 8.0, 'WFH', 'Approved Work From Home')
        ON CONFLICT (employee_record_id, attendance_date) DO NOTHING
      `).run(generateId('att'), wfh!.company_id, wfh!.employee_record_id, wfh!.wfh_date);
    }

    res.json({ ok: true, status });
  });

  // ---------------------------------------------------------------------------
  // 7. REPORTS, PAYROLL ATTENDANCE SUMMARY, NOTIFICATIONS & AUDIT LOGS
  // ---------------------------------------------------------------------------
  router.get('/reports/payroll', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));

    const summary = db
      .prepare(`
        SELECT
          e.employee_record_id, e.employee_id, e.employee_name, e.designation,
          d.name AS department_name,
          COALESCE(SUM(CASE WHEN a.status IN ('Present', 'Checked In') THEN 1 ELSE 0 END), 0) AS present_days,
          COALESCE(SUM(CASE WHEN a.is_late = 1 THEN 1 ELSE 0 END), 0) AS late_days,
          COALESCE(SUM(CASE WHEN a.is_half_day = 1 THEN 1 ELSE 0 END), 0) AS half_days,
          COALESCE(SUM(CASE WHEN a.status = 'WFH' THEN 1 ELSE 0 END), 0) AS wfh_days,
          ROUND(CAST(COALESCE(SUM(a.working_hours), 0) AS NUMERIC), 2) AS total_hours,
          COALESCE((
            SELECT SUM(l.days_count) FROM leave_applications l
            WHERE l.employee_record_id = e.employee_record_id AND l.company_id = e.company_id
              AND l.status = 'Approved' AND l.is_paid = 1 AND l.start_date LIKE ?
          ), 0) AS paid_leave_days,
          COALESCE((
            SELECT SUM(l.days_count) FROM leave_applications l
            WHERE l.employee_record_id = e.employee_record_id AND l.company_id = e.company_id
              AND l.status = 'Approved' AND l.is_paid = 0 AND l.start_date LIKE ?
          ), 0) AS unpaid_leave_days
        FROM employees e
        LEFT JOIN departments d ON d.department_id = e.department_id
        LEFT JOIN attendance_records a ON a.employee_record_id = e.employee_record_id
          AND a.company_id = e.company_id AND a.attendance_date LIKE ?
        WHERE e.company_id = ?
        GROUP BY e.employee_record_id, e.employee_id, e.employee_name, e.designation, d.name
        ORDER BY e.employee_id
      `)
      .all(`${month}%`, `${month}%`, `${month}%`, companyId);

    res.json({ month, summary });
  });

  router.get('/notifications', (req: AuthenticatedRequest, res) => {
    const companyId = req.auth!.companyId;
    if (!companyId) {
      res.json({ notifications: [] });
      return;
    }
    const rows = db
      .prepare(`
        SELECT * FROM notifications
        WHERE company_id = ? AND user_id = ?
        ORDER BY created_at DESC LIMIT 20
      `)
      .all(companyId, req.auth!.userId);
    res.json({ notifications: rows });
  });

  router.post('/notifications/read-all', (req: AuthenticatedRequest, res) => {
    if (req.auth!.companyId) {
      db.prepare('UPDATE notifications SET is_read = 1 WHERE company_id = ? AND user_id = ?').run(
        req.auth!.companyId,
        req.auth!.userId
      );
    }
    res.json({ ok: true });
  });

  router.get('/audit-logs', requireRoles('Super Admin', ...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    if (req.auth!.role === 'Super Admin') {
      const logs = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 60').all();
      res.json({ logs });
      return;
    }
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const logs = db
      .prepare('SELECT * FROM audit_logs WHERE company_id = ? ORDER BY created_at DESC LIMIT 60')
      .all(companyId);
    res.json({ logs });
  });

  // ---------------------------------------------------------------------------
  // 8. PLATFORM SUPER ADMIN TENANT MANAGEMENT
  // ---------------------------------------------------------------------------
  router.get('/platform/companies', requireRoles('Super Admin'), (_req, res) => {
    const companies = db
      .prepare(`
        SELECT c.*,
          (SELECT COUNT(*) FROM employees e WHERE e.company_id = c.company_id) AS employee_count,
          (SELECT COUNT(*) FROM users u WHERE u.company_id = c.company_id AND u.account_status = 'active') AS active_users
        FROM companies c
        ORDER BY c.created_at DESC
      `)
      .all();
    res.json({ companies });
  });

  router.post('/platform/companies/:companyId/status', requireRoles('Super Admin'), (req: AuthenticatedRequest, res) => {
    const nextStatus = req.body?.status === 'suspended' ? 'suspended' : 'active';
    const target = db
      .prepare('SELECT company_id, company_name FROM companies WHERE company_id = ?')
      .get(req.params.companyId) as { company_id: string; company_name: string } | undefined;

    if (!target) {
      res.status(404).json({ error: 'Company not found.' });
      return;
    }

    db.prepare('UPDATE companies SET status = ? WHERE company_id = ?').run(nextStatus, target.company_id);
    if (nextStatus === 'suspended') {
      revokeAllCompanySessions(db, target.company_id);
    }

    recordAuditLog(db, {
      companyId: target.company_id,
      actorUserId: req.auth!.userId,
      actorUsername: req.auth!.username,
      action: nextStatus === 'suspended' ? 'COMPANY_SUSPENDED' : 'COMPANY_ACTIVATED',
      targetType: 'company',
      targetId: target.company_id,
      outcome: 'success',
      details: `${target.company_name} status updated to ${nextStatus}`,
      ipAddress: getClientIp(req),
    });

    res.json({ ok: true, status: nextStatus });
  });

  return router;
}
