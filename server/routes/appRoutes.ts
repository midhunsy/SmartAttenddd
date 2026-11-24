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
import {
  addDays,
  evaluateBreakCompliance,
  evaluateOverallBreakCompliance,
  formatLocalDate,
  isValidDate,
  isValidTime,
  parseTimeToMinutes,
  resolveAttendanceShift,
  resolveBreakConfig,
  resolveShiftAssignment,
  type BreakConfigRow,
} from '../schedule.ts';
import { recordLeaveDeduction } from '../services/enterpriseLeave.ts';

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

  function validateScopeTarget(
    companyId: string,
    scopeType: unknown,
    scopeId: unknown
  ): { ok: true; scopeId: string | null } | { ok: false; error: string } {
    const type = String(scopeType || '');
    if (!['company', 'department', 'employee'].includes(type)) {
      return { ok: false, error: 'Scope type must be company, department, or employee.' };
    }
    if (type === 'company') {
      return { ok: true, scopeId: null };
    }
    if (!scopeId) {
      return { ok: false, error: `${type} scope requires a target.` };
    }
    const table = type === 'department' ? 'departments' : 'employees';
    const idColumn = type === 'department' ? 'department_id' : 'employee_record_id';
    const row = db
      .prepare(`SELECT company_id FROM ${table} WHERE ${idColumn} = ?`)
      .get(String(scopeId)) as { company_id: string } | undefined;
    if (!row || row.company_id !== companyId) {
      return { ok: false, error: `Invalid ${type} for your company.` };
    }
    return { ok: true, scopeId: String(scopeId) };
  }

  function hasAssignmentOverlap(
    companyId: string,
    scopeType: string,
    scopeId: string | null,
    startDate: string,
    endDate: string,
    excludeAssignmentId = ''
  ): boolean {
    const params: unknown[] = [companyId, scopeType, endDate, startDate, excludeAssignmentId];
    let scopeClause = 'scope_id IS NULL';
    if (scopeType !== 'company') {
      scopeClause = 'scope_id = ?';
      params.push(scopeId);
    }
    return Boolean(
      db
        .prepare(`
          SELECT assignment_id FROM shift_assignments
          WHERE company_id = ? AND scope_type = ?
            AND start_date <= ? AND end_date >= ?
            AND assignment_id != ? AND ${scopeClause}
          LIMIT 1
        `)
        .get(...params)
    );
  }

  function insertShiftAssignment(
    companyId: string,
    scopeType: string,
    scopeId: string | null,
    shiftId: string,
    startDate: string,
    endDate: string
  ): string {
    const assignmentId = generateId('sa');
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO shift_assignments (
        assignment_id, company_id, scope_type, scope_id, shift_id, start_date, end_date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(assignmentId, companyId, scopeType, scopeId, shiftId, startDate, endDate, now, now);
    return assignmentId;
  }

  function hasActiveBreakConfig(
    companyId: string,
    scopeType: string,
    scopeId: string | null,
    excludeConfigId = ''
  ): string | null {
    const params: unknown[] = [companyId, scopeType, excludeConfigId];
    let scopeClause = 'scope_id IS NULL';
    if (scopeType !== 'company') {
      scopeClause = 'scope_id = ?';
      params.push(scopeId);
    }
    const row = db
      .prepare(`
        SELECT config_id FROM lunch_break_configs
        WHERE company_id = ? AND scope_type = ? AND is_active = 1
          AND config_id != ? AND ${scopeClause}
        LIMIT 1
      `)
      .get(...params) as { config_id: string } | undefined;
    return row?.config_id ?? null;
  }

  function validateShiftInput(body: Record<string, unknown>): {
    ok: true;
    values: {
      name: string;
      startTime: string;
      endTime: string;
      graceMinutes: number;
      breakMinutes: number;
      workingHours: number;
    };
  } | { ok: false; error: string } {
    const name = String(body.name || '').trim();
    const startTime = String(body.startTime || '');
    const endTime = String(body.endTime || '');
    if (!name) return { ok: false, error: 'Shift name is required.' };
    if (!isValidTime(startTime) || !isValidTime(endTime)) {
      return { ok: false, error: 'Shift start and end times must use HH:MM.' };
    }
    const graceMinutes = Number(body.graceMinutes ?? 15);
    const breakMinutes = Number(body.breakMinutes ?? 60);
    const workingHours = Number(body.workingHours ?? 8);
    if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 240) {
      return { ok: false, error: 'Grace minutes must be between 0 and 240.' };
    }
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 480) {
      return { ok: false, error: 'Break minutes must be between 0 and 480.' };
    }
    if (!Number.isFinite(workingHours) || workingHours <= 0 || workingHours > 24) {
      return { ok: false, error: 'Working hours must be greater than 0 and at most 24.' };
    }
    return {
      ok: true,
      values: { name, startTime, endTime, graceMinutes, breakMinutes, workingHours },
    };
  }

  function validateBreakConfigInput(body: Record<string, unknown>): {
    ok: true;
    values: {
      breakType: string;
      durationMinutes: number;
      windowStart: string | null;
      windowEnd: string | null;
      maxDurationMinutes: number | null;
      isActive: number;
    };
  } | { ok: false; error: string } {
    const breakType = String(body.breakType || '');
    if (!['mandatory', 'optional', 'flexible'].includes(breakType)) {
      return { ok: false, error: 'Break type must be mandatory, optional, or flexible.' };
    }
    const durationMinutes = Number(body.durationMinutes ?? 60);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 480) {
      return { ok: false, error: 'Break duration must be between 1 and 480 minutes.' };
    }
    const windowStart = body.windowStart ? String(body.windowStart) : null;
    const windowEnd = body.windowEnd ? String(body.windowEnd) : null;
    if ((windowStart && !windowEnd) || (!windowStart && windowEnd)) {
      return { ok: false, error: 'Provide both break window start and end, or leave both empty.' };
    }
    if (windowStart && !isValidTime(windowStart)) {
      return { ok: false, error: 'Break window start must use HH:MM.' };
    }
    if (windowEnd && !isValidTime(windowEnd)) {
      return { ok: false, error: 'Break window end must use HH:MM.' };
    }
    const maxDurationMinutes = body.maxDurationMinutes ? Number(body.maxDurationMinutes) : null;
    if (maxDurationMinutes !== null && (!Number.isInteger(maxDurationMinutes) || maxDurationMinutes < durationMinutes)) {
      return { ok: false, error: 'Maximum break duration must be at least the configured break duration.' };
    }
    return {
      ok: true,
      values: {
        breakType,
        durationMinutes,
        windowStart,
        windowEnd,
        maxDurationMinutes,
        isActive: body.isActive === false ? 0 : 1,
      },
    };
  }

  function recordBreakEvent(
    companyId: string,
    employeeRecordId: string,
    attendanceId: string,
    config: BreakConfigRow | null,
    breakStart: string,
    breakEnd: string,
    durationMinutes: number
  ): string {
    const compliance = evaluateBreakCompliance(config, durationMinutes, breakStart, breakEnd);
    db.prepare(`
      INSERT INTO attendance_breaks (
        break_id, company_id, attendance_id, employee_record_id, break_type,
        break_start, break_end, duration_minutes, compliance, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generateId('brk'),
      companyId,
      attendanceId,
      employeeRecordId,
      config?.break_type ?? 'unconfigured',
      breakStart,
      breakEnd,
      durationMinutes,
      compliance,
      new Date().toISOString()
    );
    return compliance;
  }

  function breakEventsFor(companyId: string, attendanceId: string) {
    return db
      .prepare(`
        SELECT break_id, break_type, break_start, break_end, duration_minutes, compliance
        FROM attendance_breaks
        WHERE company_id = ? AND attendance_id = ?
        ORDER BY break_start ASC
      `)
      .all(companyId, attendanceId);
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

    const isAdmin = ADMIN_ROLES.includes(req.auth!.role);
    const departments = db.prepare('SELECT * FROM departments WHERE company_id = ? ORDER BY name').all(companyId);
    const locations = db.prepare('SELECT * FROM office_locations WHERE company_id = ? ORDER BY name').all(companyId);
    const allShifts = db.prepare('SELECT * FROM shifts WHERE company_id = ? ORDER BY name').all(companyId);
    const holidays = db.prepare('SELECT * FROM holidays WHERE company_id = ? ORDER BY holiday_date').all(companyId);
    const settings = db.prepare('SELECT * FROM company_settings WHERE company_id = ?').get(companyId);
    const effective = req.auth!.employeeRecordId
      ? resolveAttendanceShift(db, companyId, req.auth!.employeeRecordId, new Date())
      : null;
    const myBreakConfig = effective && effective.shift
      ? resolveBreakConfig(db, companyId, String(req.auth!.employeeRecordId), effective.attendanceDate)
      : null;
    const shifts = isAdmin
      ? allShifts
      : effective && effective.shift && effective.source !== 'company_default'
        ? [effective.shift]
        : [];
    const allShiftAssignments = db
      .prepare(`
        SELECT sa.*, s.name AS shift_name, s.start_time, s.end_time, s.working_hours,
               d.name AS department_name, e.employee_name
        FROM shift_assignments sa
        JOIN shifts s ON s.shift_id = sa.shift_id AND s.company_id = sa.company_id
        LEFT JOIN departments d ON sa.scope_type = 'department' AND d.department_id = sa.scope_id AND d.company_id = sa.company_id
        LEFT JOIN employees e ON sa.scope_type = 'employee' AND e.employee_record_id = sa.scope_id AND e.company_id = sa.company_id
        WHERE sa.company_id = ?
        ORDER BY sa.start_date DESC
      `)
      .all(companyId);
    const allLunchBreakConfigs = db
      .prepare(`
        SELECT lc.*, d.name AS department_name, e.employee_name
        FROM lunch_break_configs lc
        LEFT JOIN departments d ON lc.scope_type = 'department' AND d.department_id = lc.scope_id AND d.company_id = lc.company_id
        LEFT JOIN employees e ON lc.scope_type = 'employee' AND e.employee_record_id = lc.scope_id AND e.company_id = lc.company_id
        WHERE lc.company_id = ?
        ORDER BY lc.updated_at DESC
      `)
      .all(companyId);
    const shiftAssignments = isAdmin ? allShiftAssignments : effective?.assignment ? [effective.assignment] : [];
    const lunchBreakConfigs = isAdmin ? allLunchBreakConfigs : myBreakConfig ? [myBreakConfig] : [];
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
    const assignableEmployees = db
      .prepare(`
        SELECT e.employee_record_id, e.employee_id, e.employee_name, r.role_name
        FROM employees e
        JOIN users u ON u.user_id = e.user_id
        LEFT JOIN roles r ON r.role_id = u.role_id
        WHERE e.company_id = ? AND e.employment_status = 'active' AND u.account_status = 'active'
        ORDER BY e.employee_name
      `)
      .all(companyId);

    res.json({
      departments,
      locations,
      shifts,
      holidays,
      settings,
      managers: isAdmin ? managers : [],
      employees: isAdmin ? assignableEmployees : [],
      shiftAssignments,
      lunchBreakConfigs,
      effectiveShift: effective?.shift ?? null,
      myBreakConfig,
    });
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
    const validation = validateShiftInput(req.body || {});
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const id = generateId('shift');
    const values = validation.values;
    db.prepare(`
      INSERT INTO shifts (shift_id, company_id, name, start_time, end_time, grace_minutes, break_minutes, working_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      companyId,
      values.name,
      values.startTime,
      values.endTime,
      values.graceMinutes,
      values.breakMinutes,
      values.workingHours
    );
    res.status(201).json({ shiftId: id });
  });

  router.patch('/shifts/:shiftId', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const existing = db
      .prepare('SELECT shift_id FROM shifts WHERE shift_id = ? AND company_id = ?')
      .get(req.params.shiftId, companyId);
    if (!existing) {
      res.status(404).json({ error: 'Shift not found.' });
      return;
    }
    const current = db
      .prepare('SELECT name, start_time, end_time, grace_minutes, break_minutes, working_hours FROM shifts WHERE shift_id = ? AND company_id = ?')
      .get(req.params.shiftId, companyId) as Record<string, unknown>;
    const validation = validateShiftInput({
      name: req.body?.name ?? current.name,
      startTime: req.body?.startTime ?? current.start_time,
      endTime: req.body?.endTime ?? current.end_time,
      graceMinutes: req.body?.graceMinutes ?? current.grace_minutes,
      breakMinutes: req.body?.breakMinutes ?? current.break_minutes,
      workingHours: req.body?.workingHours ?? current.working_hours,
    });
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const values = validation.values;
    db.prepare(`
      UPDATE shifts
      SET name = ?, start_time = ?, end_time = ?, grace_minutes = ?, break_minutes = ?, working_hours = ?
      WHERE shift_id = ? AND company_id = ?
    `).run(
      values.name,
      values.startTime,
      values.endTime,
      values.graceMinutes,
      values.breakMinutes,
      values.workingHours,
      req.params.shiftId,
      companyId
    );
    res.json({ ok: true });
  });

  router.delete('/shifts/:shiftId', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const inUse = db
      .prepare('SELECT assignment_id FROM shift_assignments WHERE shift_id = ? AND company_id = ? LIMIT 1')
      .get(req.params.shiftId, companyId);
    if (inUse) {
      res.status(409).json({
        error: 'This shift is used by a scheduled assignment. Remove or reschedule those assignments first.',
        code: 'SHIFT_IN_USE',
      });
      return;
    }
    db.prepare('DELETE FROM shifts WHERE shift_id = ? AND company_id = ?').run(req.params.shiftId, companyId);
    res.json({ ok: true });
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

  router.get('/shift-assignments', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const rows = db
      .prepare(`
        SELECT sa.*, s.name AS shift_name, s.start_time, s.end_time,
               d.name AS department_name, e.employee_name
        FROM shift_assignments sa
        JOIN shifts s ON s.shift_id = sa.shift_id AND s.company_id = sa.company_id
        LEFT JOIN departments d ON sa.scope_type = 'department' AND d.department_id = sa.scope_id AND d.company_id = sa.company_id
        LEFT JOIN employees e ON sa.scope_type = 'employee' AND e.employee_record_id = sa.scope_id AND e.company_id = sa.company_id
        WHERE sa.company_id = ?
        ORDER BY
          CASE sa.scope_type WHEN 'employee' THEN 3 WHEN 'department' THEN 2 ELSE 1 END DESC,
          sa.start_date DESC
      `)
      .all(companyId);
    res.json({ assignments: rows });
  });

  router.post('/shift-assignments', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const { scopeType, scopeId, shiftId, startDate, endDate } = req.body || {};
    const scope = validateScopeTarget(companyId, scopeType, scopeId);
    if (!scope.ok) {
      res.status(400).json({ error: scope.error });
      return;
    }
    const shift = db
      .prepare('SELECT shift_id FROM shifts WHERE shift_id = ? AND company_id = ?')
      .get(String(shiftId || ''), companyId);
    if (!shift) {
      res.status(400).json({ error: 'Invalid shift for your company.' });
      return;
    }
    if (!isValidDate(startDate) || !isValidDate(endDate) || String(startDate) > String(endDate)) {
      res.status(400).json({ error: 'Provide a valid start date and an end date on or after the start date.' });
      return;
    }
    if (hasAssignmentOverlap(companyId, String(scopeType), scope.scopeId, String(startDate), String(endDate))) {
      res.status(409).json({
        error: 'An overlapping shift assignment already exists for this scope.',
        code: 'SHIFT_ASSIGNMENT_OVERLAP',
      });
      return;
    }
    const assignmentId = generateId('sa');
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO shift_assignments (
        assignment_id, company_id, scope_type, scope_id, shift_id, start_date, end_date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(assignmentId, companyId, String(scopeType), scope.scopeId, String(shiftId), String(startDate), String(endDate), now, now);
    res.status(201).json({ assignmentId });
  });

  router.patch('/shift-assignments/:assignmentId', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const existing = db
      .prepare('SELECT * FROM shift_assignments WHERE assignment_id = ? AND company_id = ?')
      .get(req.params.assignmentId, companyId) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Shift assignment not found.' });
      return;
    }
    const today = formatLocalDate(new Date());
    const cutoff = req.body?.effectiveDate ? String(req.body.effectiveDate) : today;
    if (!isValidDate(cutoff) || cutoff < today) {
      res.status(400).json({ error: 'effectiveDate must be today or a future date.' });
      return;
    }
    const oldStart = String(existing.start_date);
    const oldEnd = String(existing.end_date);
    if (oldEnd < cutoff) {
      res.status(409).json({
        error: 'Historical shift assignments cannot be modified.',
        code: 'SCHEDULE_HISTORY_IMMUTABLE',
      });
      return;
    }
    const nextScopeType = req.body?.scopeType ?? existing.scope_type;
    const nextScopeId = req.body?.scopeId ?? existing.scope_id;
    const scope = validateScopeTarget(companyId, nextScopeType, nextScopeId);
    if (!scope.ok) {
      res.status(400).json({ error: scope.error });
      return;
    }
    const nextShiftId = String(req.body?.shiftId ?? existing.shift_id);
    const shift = db.prepare('SELECT shift_id FROM shifts WHERE shift_id = ? AND company_id = ?').get(nextShiftId, companyId);
    if (!shift) {
      res.status(400).json({ error: 'Invalid shift for your company.' });
      return;
    }
    const startDate = String(req.body?.startDate ?? oldStart);
    const endDate = String(req.body?.endDate ?? oldEnd);
    if (!isValidDate(startDate) || !isValidDate(endDate) || startDate > endDate) {
      res.status(400).json({ error: 'Provide a valid start date and an end date on or after the start date.' });
      return;
    }
    if (endDate < cutoff || (oldStart >= cutoff && startDate < cutoff)) {
      res.status(409).json({
        error: 'Historical shift assignments cannot be modified.',
        code: 'SCHEDULE_HISTORY_IMMUTABLE',
      });
      return;
    }
    const scopeType = String(nextScopeType);
    const assignmentId = String(existing.assignment_id);
    const now = new Date().toISOString();
    const overlapError = () => ({
      error: 'An overlapping shift assignment already exists for this scope.',
      code: 'SHIFT_ASSIGNMENT_OVERLAP',
    });

    if (oldStart >= cutoff) {
      if (hasAssignmentOverlap(companyId, scopeType, scope.scopeId, startDate, endDate, assignmentId)) {
        res.status(409).json(overlapError());
        return;
      }
      db.prepare(`
        UPDATE shift_assignments
        SET scope_type = ?, scope_id = ?, shift_id = ?, start_date = ?, end_date = ?, updated_at = ?
        WHERE assignment_id = ? AND company_id = ?
      `).run(scopeType, scope.scopeId, nextShiftId, startDate, endDate, now, assignmentId, companyId);
      res.json({ ok: true, split: false });
      return;
    }

    const futureStart = startDate > cutoff ? startDate : cutoff;
    const oldScopeType = String(existing.scope_type);
    const oldScopeId = oldScopeType === 'company'
      ? null
      : existing.scope_id === null || existing.scope_id === undefined
        ? null
        : String(existing.scope_id);

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(`
        UPDATE shift_assignments SET end_date = ?, updated_at = ?
        WHERE assignment_id = ? AND company_id = ?
      `).run(addDays(cutoff, -1), now, assignmentId, companyId);
      const createdIds: string[] = [];

      if (futureStart > cutoff) {
        const bridgeEnd = addDays(futureStart, -1);
        if (hasAssignmentOverlap(companyId, oldScopeType, oldScopeId, cutoff, bridgeEnd, assignmentId)) {
          throw new Error('OVERLAP');
        }
        createdIds.push(insertShiftAssignment(
          companyId,
          oldScopeType,
          oldScopeId,
          String(existing.shift_id),
          cutoff,
          bridgeEnd
        ));
      }

      if (hasAssignmentOverlap(companyId, scopeType, scope.scopeId, futureStart, endDate, assignmentId)) {
        throw new Error('OVERLAP');
      }
      createdIds.push(insertShiftAssignment(companyId, scopeType, scope.scopeId, nextShiftId, futureStart, endDate));
      db.exec('COMMIT;');
      res.json({ ok: true, split: true, assignmentIds: createdIds });
    } catch (err) {
      db.exec('ROLLBACK;');
      if (err instanceof Error && err.message === 'OVERLAP') {
        res.status(409).json(overlapError());
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Schedule update failed.' });
    }
  });

  router.delete('/shift-assignments/:assignmentId', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const existing = db
      .prepare('SELECT start_date, end_date FROM shift_assignments WHERE assignment_id = ? AND company_id = ?')
      .get(req.params.assignmentId, companyId) as { start_date: string; end_date: string } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Shift assignment not found.' });
      return;
    }
    const today = formatLocalDate(new Date());
    const cutoff = req.query.effectiveDate ? String(req.query.effectiveDate) : today;
    if (!isValidDate(cutoff) || cutoff < today) {
      res.status(400).json({ error: 'effectiveDate must be today or a future date.' });
      return;
    }
    if (existing.end_date < cutoff) {
      res.status(409).json({
        error: 'Historical shift assignments cannot be deleted.',
        code: 'SCHEDULE_HISTORY_IMMUTABLE',
      });
      return;
    }
    if (existing.start_date < cutoff) {
      db.prepare(`
        UPDATE shift_assignments SET end_date = ?, updated_at = ?
        WHERE assignment_id = ? AND company_id = ?
      `).run(addDays(cutoff, -1), new Date().toISOString(), req.params.assignmentId, companyId);
      res.json({ ok: true, trimmed: true });
      return;
    }
    db.prepare('DELETE FROM shift_assignments WHERE assignment_id = ? AND company_id = ?').run(
      req.params.assignmentId,
      companyId
    );
    res.json({ ok: true, trimmed: false });
  });

  router.get('/shifts/effective', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const employeeRecordId = String(req.query.employeeRecordId || req.auth!.employeeRecordId || '');
    if (!employeeRecordId) {
      res.status(400).json({ error: 'An employee record is required.' });
      return;
    }
    if (employeeRecordId !== req.auth!.employeeRecordId && !ADMIN_ROLES.includes(req.auth!.role)) {
      res.status(403).json({ error: 'You can only preview your own effective shift.' });
      return;
    }
    const date = String(req.query.date || formatLocalDate(new Date()));
    if (!isValidDate(date)) {
      res.status(400).json({ error: 'Date must use YYYY-MM-DD.' });
      return;
    }
    const resolved = resolveShiftAssignment(db, companyId, employeeRecordId, date);
    const isAdmin = ADMIN_ROLES.includes(req.auth!.role);
    const visible = isAdmin || resolved.source !== 'company_default';
    res.json({
      date,
      source: visible ? resolved.source : 'none',
      shift: visible ? resolved.shift : null,
      assignment: visible ? resolved.assignment : null,
    });
  });

  router.get('/lunch-break-configs', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const configs = db
      .prepare(`
        SELECT lc.*, d.name AS department_name, e.employee_name
        FROM lunch_break_configs lc
        LEFT JOIN departments d ON lc.scope_type = 'department' AND d.department_id = lc.scope_id AND d.company_id = lc.company_id
        LEFT JOIN employees e ON lc.scope_type = 'employee' AND e.employee_record_id = lc.scope_id AND e.company_id = lc.company_id
        WHERE lc.company_id = ?
        ORDER BY lc.updated_at DESC
      `)
      .all(companyId);
    res.json({ configs });
  });

  router.post('/lunch-break-configs', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const scope = validateScopeTarget(companyId, req.body?.scopeType, req.body?.scopeId);
    if (!scope.ok) {
      res.status(400).json({ error: scope.error });
      return;
    }
    const validation = validateBreakConfigInput(req.body || {});
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    if (hasActiveBreakConfig(companyId, String(req.body.scopeType), scope.scopeId)) {
      res.status(409).json({
        error: 'An active break configuration already exists for this scope.',
        code: 'BREAK_CONFIG_EXISTS',
      });
      return;
    }
    const configId = generateId('lbc');
    const now = new Date().toISOString();
    const values = validation.values;
    db.prepare(`
      INSERT INTO lunch_break_configs (
        config_id, company_id, scope_type, scope_id, break_type, duration_minutes,
        window_start, window_end, max_duration_minutes, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      configId,
      companyId,
      String(req.body.scopeType),
      scope.scopeId,
      values.breakType,
      values.durationMinutes,
      values.windowStart,
      values.windowEnd,
      values.maxDurationMinutes,
      values.isActive,
      now,
      now
    );
    res.status(201).json({ configId });
  });

  router.patch('/lunch-break-configs/:configId', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const existing = db
      .prepare('SELECT * FROM lunch_break_configs WHERE config_id = ? AND company_id = ?')
      .get(req.params.configId, companyId) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Lunch break configuration not found.' });
      return;
    }
    const scope = validateScopeTarget(
      companyId,
      req.body?.scopeType ?? existing.scope_type,
      req.body?.scopeId ?? existing.scope_id
    );
    if (!scope.ok) {
      res.status(400).json({ error: scope.error });
      return;
    }
    const validation = validateBreakConfigInput({
      breakType: req.body?.breakType ?? existing.break_type,
      durationMinutes: req.body?.durationMinutes ?? existing.duration_minutes,
      windowStart: req.body?.windowStart ?? existing.window_start,
      windowEnd: req.body?.windowEnd ?? existing.window_end,
      maxDurationMinutes: req.body?.maxDurationMinutes ?? existing.max_duration_minutes,
      isActive: req.body?.isActive ?? existing.is_active,
    });
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const values = validation.values;
    const nextScopeType = String(req.body?.scopeType ?? existing.scope_type);
    if (
      values.isActive
      && hasActiveBreakConfig(companyId, nextScopeType, scope.scopeId, String(existing.config_id))
    ) {
      res.status(409).json({
        error: 'An active break configuration already exists for this scope.',
        code: 'BREAK_CONFIG_EXISTS',
      });
      return;
    }
    db.prepare(`
      UPDATE lunch_break_configs
      SET scope_type = ?, scope_id = ?, break_type = ?, duration_minutes = ?,
          window_start = ?, window_end = ?, max_duration_minutes = ?, is_active = ?, updated_at = ?
      WHERE config_id = ? AND company_id = ?
    `).run(
      nextScopeType,
      scope.scopeId,
      values.breakType,
      values.durationMinutes,
      values.windowStart,
      values.windowEnd,
      values.maxDurationMinutes,
      values.isActive,
      new Date().toISOString(),
      existing.config_id,
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
          e.employee_name, e.email, e.mobile, e.address, e.department_id, e.designation,
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
          e.employee_name, e.email, e.mobile, e.address, e.department_id, e.designation,
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
      address,
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
    const eAddress = String(address || '').trim();
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
    if (eAddress.length > 500) {
      res.status(400).json({ error: 'Address must be 500 characters or fewer.' });
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
          employee_record_id, employee_id, user_id, company_id, employee_name, email, mobile, address,
          department_id, designation, reporting_manager_id, hod_id, joining_date, employment_type,
          office_location_id, assigned_shift_id, employment_status, profile_picture, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        employeeRecordId,
        generatedEmployeeId,
        userId,
        companyId,
        eName,
        eEmail,
        eMobile,
        eAddress || null,
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
          address: eAddress || null,
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
      .prepare('SELECT employee_record_id, user_id, company_id, employee_id, address FROM employees WHERE employee_record_id = ?')
      .get(req.params.employeeRecordId) as
      | { employee_record_id: string; user_id: string; company_id: string; employee_id: string; address: string | null }
      | undefined;

    if (blockCrossCompanyAttempt(req, res, existing?.company_id, 'employee', req.params.employeeRecordId)) return;

    const {
      employeeName,
      email,
      mobile,
      address,
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

    if (address !== undefined && String(address).trim().length > 500) {
      res.status(400).json({ error: 'Address must be 500 characters or fewer.' });
      return;
    }

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(`
        UPDATE employees
        SET employee_name = COALESCE(?, employee_name),
            email = COALESCE(?, email),
            mobile = COALESCE(?, mobile),
            address = ?,
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
        address === undefined ? existing?.address ?? null : String(address).trim() || null,
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
    const records = (db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map((record) => ({
      ...record,
      break_events: breakEventsFor(companyId, String(record.attendance_id)),
    }));

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
      const effective = resolveAttendanceShift(db, companyId, req.auth!.employeeRecordId, new Date());
      if (effective.shift) {
        assignedShift = effective.shift;
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
        SELECT e.employee_record_id, e.assigned_shift_id,
               l.latitude AS loc_lat, l.longitude AS loc_lng, l.radius_meters, l.name AS loc_name
        FROM employees e
        LEFT JOIN office_locations l ON l.location_id = e.office_location_id
        WHERE e.employee_record_id = ? AND e.company_id = ?
      `)
      .get(req.auth!.employeeRecordId, companyId) as
      | {
          employee_record_id: string;
          assigned_shift_id: string | null;
          loc_lat: number | null;
          loc_lng: number | null;
          radius_meters: number | null;
          loc_name: string | null;
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
    const resolved = resolveAttendanceShift(db, companyId, emp.employee_record_id, now);
    const today = resolved.attendanceDate;
    const effectiveShift = resolved.shift;
    const breakConfig = resolveBreakConfig(db, companyId, emp.employee_record_id, today);
    const existing = db
      .prepare('SELECT attendance_id FROM attendance_records WHERE employee_record_id = ? AND attendance_date = ?')
      .get(emp.employee_record_id, today);

    if (existing) {
      res.status(409).json({ error: 'You have already checked in for this shift date.' });
      return;
    }

    const shiftStart = effectiveShift?.start_time || '09:00';
    const grace = effectiveShift?.grace_minutes ?? settings?.grace_period_minutes ?? 15;
    const shiftMinutes = parseTimeToMinutes(shiftStart, 540);
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
        break_minutes, working_hours, is_late, late_minutes, is_half_day, status, notes,
        effective_shift_date, expected_working_hours, shift_start_time, shift_end_time,
        break_policy_type, break_compliance, break_completed_minutes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      attId,
      companyId,
      emp.employee_record_id,
      today,
      effectiveShift?.shift_id ?? emp.assigned_shift_id,
      nowIso,
      lat,
      lng,
      distance,
      geofenceStatus,
      isLate,
      lateMinutes,
      isLate ? 'Late (Checked In)' : 'Checked In',
      notes,
      today,
      effectiveShift?.working_hours ?? 8,
      effectiveShift?.start_time ?? shiftStart,
      effectiveShift?.end_time ?? null,
      breakConfig?.break_type ?? 'unconfigured',
      breakConfig?.break_type === 'mandatory' ? 'pending' : 'not_applicable'
    );

    db.prepare(`
      INSERT INTO gps_logs (gps_id, company_id, employee_record_id, attendance_id, event_type, latitude, longitude, distance_meters, within_geofence, recorded_at)
      VALUES (?, ?, ?, ?, 'Check-In', ?, ?, ?, ?, ?)
    `).run(generateId('gps'), companyId, emp.employee_record_id, attId, lat, lng, distance, withinGeofence, nowIso);

    res.status(201).json({
      attendanceId: attId,
      attendanceDate: today,
      shiftId: effectiveShift?.shift_id ?? emp.assigned_shift_id ?? null,
      shiftName: effectiveShift?.name ?? null,
      shiftSource: resolved.source,
      expectedWorkingHours: effectiveShift?.working_hours ?? 8,
      breakPolicy: breakConfig?.break_type ?? 'unconfigured',
      isLate: Boolean(isLate),
      lateMinutes,
      geofenceStatus,
    });
  });

  router.post('/attendance/break', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId || !req.auth!.employeeRecordId) return;

    const now = new Date();
    const resolved = resolveAttendanceShift(db, companyId, req.auth!.employeeRecordId, now);
    const rec = db
      .prepare('SELECT * FROM attendance_records WHERE company_id = ? AND employee_record_id = ? AND attendance_date = ?')
      .get(companyId, req.auth!.employeeRecordId, resolved.attendanceDate) as
      | {
          attendance_id: string;
          check_out_time: string | null;
          active_break_start: string | null;
          break_minutes: number;
          break_completed_minutes: number;
          effective_shift_date: string | null;
        }
      | undefined;

    if (!rec || rec.check_out_time) {
      res.status(400).json({ error: 'Active check-in required to toggle break.' });
      return;
    }

    const config = resolveBreakConfig(db, companyId, req.auth!.employeeRecordId, rec.effective_shift_date ?? resolved.attendanceDate);
    const nowIso = now.toISOString();
    if (!rec.active_break_start) {
      db.prepare('UPDATE attendance_records SET active_break_start = ?, break_policy_type = ? WHERE attendance_id = ?').run(
        nowIso,
        config?.break_type ?? 'unconfigured',
        rec.attendance_id
      );
      res.json({
        onBreak: true,
        breakMinutes: rec.break_minutes,
        breakPolicy: config?.break_type ?? 'unconfigured',
        requiredMinutes: config?.duration_minutes ?? null,
        window: config?.window_start && config?.window_end ? `${config.window_start}-${config.window_end}` : null,
      });
      return;
    }

    const addedMins = Math.max(1, Math.round((now.getTime() - Date.parse(rec.active_break_start)) / 60000));
    const totalBreak = rec.break_minutes + addedMins;
    const eventCompliance = recordBreakEvent(
      companyId,
      req.auth!.employeeRecordId,
      rec.attendance_id,
      config,
      rec.active_break_start,
      nowIso,
      addedMins
    );
    const completedMinutes = rec.break_completed_minutes + (eventCompliance === 'completed' ? addedMins : 0);
    const overallCompliance = evaluateOverallBreakCompliance(config, completedMinutes, eventCompliance);
    db.prepare(`
      UPDATE attendance_records
      SET active_break_start = NULL, break_minutes = ?, break_policy_type = ?,
          break_compliance = ?, break_completed_minutes = ?
      WHERE attendance_id = ?
    `).run(totalBreak, config?.break_type ?? 'unconfigured', overallCompliance, completedMinutes, rec.attendance_id);
    res.json({
      onBreak: false,
      breakMinutes: totalBreak,
      breakPolicy: config?.break_type ?? 'unconfigured',
      breakCompliance: overallCompliance,
      requiredMinutes: config?.duration_minutes ?? null,
      events: breakEventsFor(companyId, rec.attendance_id),
    });
  });

  router.post('/attendance/check-out', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId || !req.auth!.employeeRecordId) return;

    const now = new Date();
    const resolved = resolveAttendanceShift(db, companyId, req.auth!.employeeRecordId, now);
    const rec = db
      .prepare('SELECT * FROM attendance_records WHERE company_id = ? AND employee_record_id = ? AND attendance_date = ?')
      .get(companyId, req.auth!.employeeRecordId, resolved.attendanceDate) as
      | {
          attendance_id: string;
          check_in_time: string;
          check_out_time: string | null;
          active_break_start: string | null;
          break_minutes: number;
          break_completed_minutes: number;
          break_compliance: string | null;
          effective_shift_date: string | null;
          expected_working_hours: number;
          is_late: number;
          check_in_lat: number;
          check_in_lng: number;
        }
      | undefined;

    if (!rec) {
      res.status(400).json({ error: 'No check-in record found for this shift date.' });
      return;
    }
    if (rec.check_out_time) {
      res.status(409).json({ error: 'You have already checked out for this shift date.' });
      return;
    }

    const config = resolveBreakConfig(db, companyId, req.auth!.employeeRecordId, rec.effective_shift_date ?? resolved.attendanceDate);
    const nowIso = now.toISOString();
    let totalBreakMins = rec.break_minutes;
    let completedMinutes = rec.break_completed_minutes;
    let lastEventCompliance: string | null = null;

    if (rec.active_break_start) {
      const addedMins = Math.max(1, Math.round((now.getTime() - Date.parse(rec.active_break_start)) / 60000));
      lastEventCompliance = recordBreakEvent(
        companyId,
        req.auth!.employeeRecordId,
        rec.attendance_id,
        config,
        rec.active_break_start,
        nowIso,
        addedMins
      );
      totalBreakMins += addedMins;
      if (lastEventCompliance === 'completed') completedMinutes += addedMins;
    }

    const compliance = evaluateOverallBreakCompliance(config, completedMinutes, lastEventCompliance);

    const settings = db
      .prepare('SELECT half_day_hours, full_day_hours FROM company_settings WHERE company_id = ?')
      .get(companyId) as { half_day_hours: number; full_day_hours: number } | undefined;
    const expectedHours = Number(rec.expected_working_hours) > 0
      ? Number(rec.expected_working_hours)
      : Number(settings?.full_day_hours ?? 8);
    const elapsedHours = Math.max(0.1, (now.getTime() - Date.parse(rec.check_in_time)) / 3600000 - totalBreakMins / 60);
    const workingHours = Number(Math.min(elapsedHours, expectedHours || 8).toFixed(2));
    const halfDayThreshold = Number(settings?.half_day_hours ?? expectedHours / 2) || expectedHours / 2;
    const isHalfDay = workingHours < halfDayThreshold ? 1 : 0;
    const finalStatus = isHalfDay ? 'Half-Day' : rec.is_late ? 'Late' : 'Present';

    const lat = Number(req.body?.latitude ?? rec.check_in_lat ?? 37.7749);
    const lng = Number(req.body?.longitude ?? rec.check_in_lng ?? -122.4194);

    db.prepare(`
      UPDATE attendance_records
      SET check_out_time = ?, check_out_lat = ?, check_out_lng = ?,
          active_break_start = NULL, break_minutes = ?, working_hours = ?,
          is_half_day = ?, status = ?, break_policy_type = ?, break_compliance = ?,
          break_completed_minutes = ?
      WHERE attendance_id = ? AND company_id = ?
    `).run(
      nowIso,
      lat,
      lng,
      totalBreakMins,
      workingHours,
      isHalfDay,
      finalStatus,
      config?.break_type ?? 'unconfigured',
      compliance,
      completedMinutes,
      rec.attendance_id,
      companyId
    );

    db.prepare(`
      INSERT INTO gps_logs (gps_id, company_id, employee_record_id, attendance_id, event_type, latitude, longitude, distance_meters, within_geofence, recorded_at)
      VALUES (?, ?, ?, ?, 'Check-Out', ?, ?, 0, 1, ?)
    `).run(generateId('gps'), companyId, req.auth!.employeeRecordId, rec.attendance_id, lat, lng, nowIso);

    res.json({
      workingHours,
      expectedWorkingHours: expectedHours,
      isHalfDay: Boolean(isHalfDay),
      status: finalStatus,
      breakMinutes: totalBreakMins,
      breakPolicy: config?.break_type ?? 'unconfigured',
      breakCompliance: compliance,
      events: breakEventsFor(companyId, rec.attendance_id),
    });
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
        recordLeaveDeduction(
          db,
          leave!.company_id,
          leave!.employee_record_id,
          leave!.leave_type,
          leave!.days_count,
          leave!.leave_id,
          req.auth!.fullName || req.auth!.username
        );
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
      const resolvedForDate = resolveShiftAssignment(
        db,
        reg!.company_id,
        reg!.employee_record_id,
        reg!.attendance_date
      );
      const expectedHours = resolvedForDate.shift?.working_hours ?? 8;
      const breakMinutes = resolvedForDate.shift?.break_minutes ?? 60;
      const rawHours = (Date.parse(checkOutIso) - Date.parse(checkInIso)) / 3600000 - breakMinutes / 60;
      const hours = Number(Math.min(Math.max(0.5, rawHours), expectedHours).toFixed(2));
      const existingAtt = db
        .prepare('SELECT attendance_id FROM attendance_records WHERE company_id = ? AND employee_record_id = ? AND attendance_date = ?')
        .get(reg!.company_id, reg!.employee_record_id, reg!.attendance_date) as { attendance_id: string } | undefined;

      if (existingAtt) {
        db.prepare(`
          UPDATE attendance_records
          SET check_in_time = ?, check_out_time = ?, working_hours = ?, expected_working_hours = ?,
              effective_shift_date = ?, shift_id = ?, shift_start_time = ?, shift_end_time = ?,
              is_late = 0, late_minutes = 0, status = 'Present', notes = 'Regularized'
          WHERE attendance_id = ?
        `).run(
          checkInIso,
          checkOutIso,
          hours,
          expectedHours,
          reg!.attendance_date,
          resolvedForDate.shift?.shift_id ?? null,
          resolvedForDate.shift?.start_time ?? null,
          resolvedForDate.shift?.end_time ?? null,
          existingAtt.attendance_id
        );
      } else {
        db.prepare(`
          INSERT INTO attendance_records (
            attendance_id, company_id, employee_record_id, attendance_date, check_in_time, check_out_time,
            geofence_status, working_hours, expected_working_hours, effective_shift_date, shift_id,
            shift_start_time, shift_end_time, status, notes
          )
          VALUES (?, ?, ?, ?, ?, ?, 'Regularized', ?, ?, ?, ?, ?, ?, 'Present', 'Regularized')
        `).run(
          generateId('att'),
          reg!.company_id,
          reg!.employee_record_id,
          reg!.attendance_date,
          checkInIso,
          checkOutIso,
          hours,
          expectedHours,
          reg!.attendance_date,
          resolvedForDate.shift?.shift_id ?? null,
          resolvedForDate.shift?.start_time ?? null,
          resolvedForDate.shift?.end_time ?? null
        );
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
      const resolved = resolveShiftAssignment(
        db,
        wfh!.company_id,
        wfh!.employee_record_id,
        wfh!.wfh_date
      );
      const expectedHours = resolved.shift?.working_hours ?? 8;
      db.prepare(`
        INSERT INTO attendance_records (
          attendance_id, company_id, employee_record_id, attendance_date, geofence_status,
          working_hours, expected_working_hours, effective_shift_date, shift_id,
          shift_start_time, shift_end_time, status, notes
        )
        VALUES (?, ?, ?, ?, 'Remote WFH', ?, ?, ?, ?, ?, ?, 'WFH', 'Approved Work From Home')
        ON CONFLICT (employee_record_id, attendance_date) DO NOTHING
      `).run(
        generateId('att'),
        wfh!.company_id,
        wfh!.employee_record_id,
        wfh!.wfh_date,
        expectedHours,
        expectedHours,
        wfh!.wfh_date,
        resolved.shift?.shift_id ?? null,
        resolved.shift?.start_time ?? null,
        resolved.shift?.end_time ?? null
      );
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
