import { Router } from 'express';
import type { Response } from 'express';
import type { ServerDatabase } from '../postgres.ts';
import {
  authenticateSession,
  generateId,
  getClientIp,
  recordAuditLog,
  requirePasswordChanged,
  requireRoles,
  type AuthenticatedRequest,
} from '../auth.ts';
import {
  ensureCurrentPeriodAccrual,
  getActivePolicies,
  getLeaveOverview,
  runAccrualForEmployee,
  type LeavePolicyRow,
} from '../services/enterpriseLeave.ts';

const ADMIN_ROLES = ['Company Admin', 'HR'];
const APPROVER_ROLES = ['Company Admin', 'HR', 'HOD', 'Manager', 'Responsible Person'];
const EXPENSE_CATEGORIES = ['Transportation', 'Food', 'Accommodation', 'Parking', 'Other'];
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function monthPeriod(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return null;
  const month = num(value.slice(5, 7));
  return month >= 1 && month <= 12 ? value : null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

function detectConflicts(
  db: ServerDatabase,
  companyId: string,
  employeeRecordId: string,
  requestedShiftId: string,
  startDate: string,
  endDate: string,
  excludeRequestId?: string
): string[] {
  const conflicts: string[] = [];
  const overlaps = (rowStart: string, rowEnd: string) => rowStart <= endDate && rowEnd >= startDate;

  const approved = db
    .prepare(
      `SELECT request_id, start_date, end_date FROM shift_change_requests
       WHERE company_id = ? AND employee_record_id = ? AND status = 'Approved' AND requested_shift_id <> ?`
    )
    .all(companyId, employeeRecordId, requestedShiftId) as Array<{
    request_id: string;
    start_date: string;
    end_date: string;
  }>;
  for (const row of approved) {
    if (row.request_id === excludeRequestId) continue;
    if (overlaps(row.start_date, row.end_date)) {
      conflicts.push(`Approved shift change already covers ${row.start_date} to ${row.end_date}`);
    }
  }

  const overrideSql = excludeRequestId
    ? `SELECT start_date, end_date FROM shift_schedule_overrides
       WHERE company_id = ? AND employee_record_id = ? AND shift_id <> ? AND request_id <> ?`
    : `SELECT start_date, end_date FROM shift_schedule_overrides
       WHERE company_id = ? AND employee_record_id = ? AND shift_id <> ?`;
  const overrides = (excludeRequestId
    ? db.prepare(overrideSql).all(companyId, employeeRecordId, requestedShiftId, excludeRequestId)
    : db.prepare(overrideSql).all(companyId, employeeRecordId, requestedShiftId)) as Array<{
    start_date: string;
    end_date: string;
  }>;
  for (const row of overrides) {
    if (overlaps(row.start_date, row.end_date)) {
      conflicts.push(`Schedule override already covers ${row.start_date} to ${row.end_date}`);
    }
  }

  const attendance = db
    .prepare(
      `SELECT attendance_date, shift_id FROM attendance_records
       WHERE company_id = ? AND employee_record_id = ? AND shift_id IS NOT NULL AND shift_id <> ?
         AND attendance_date >= ? AND attendance_date <= ?`
    )
    .all(companyId, employeeRecordId, requestedShiftId, startDate, endDate) as Array<{
    attendance_date: string;
    shift_id: string;
  }>;
  for (const row of attendance) {
    conflicts.push(`Attendance on ${row.attendance_date} is recorded against a different shift (${row.shift_id})`);
  }

  return [...new Set(conflicts)];
}

interface ParsedPolicyInput {
  leaveType: string;
  accrualMethod: string;
  monthlyEntitlement: number;
  annualEntitlement: number;
  creditDay: number;
  accrualTiming: string;
  eligibility: string;
  probationMonths: number;
  prorateByJoiningDate: number;
  carryForward: number;
  carryForwardCap: number;
  expiryMonths: number;
  maxBalance: number;
  fractionalSupport: number;
  effectiveFrom: string;
}

function parsePolicyInput(body: Record<string, unknown>, existing?: LeavePolicyRow): ParsedPolicyInput | string {
  const raw = body || {};
  const leaveType = String(raw.leaveType ?? existing?.leave_type ?? '').trim();
  if (!leaveType) return 'Leave type is required.';

  const accrualMethod = String(raw.accrualMethod ?? existing?.accrual_method ?? '');
  if (!['Annual', 'Monthly'].includes(accrualMethod)) return 'Accrual method must be Annual or Monthly.';

  const effectiveFrom = isoDate(raw.effectiveFrom ?? existing?.effective_from ?? todayIso());
  if (!effectiveFrom) return 'Effective from must be a valid ISO date (YYYY-MM-DD).';

  const accrualTiming = String(raw.accrualTiming ?? existing?.accrual_timing ?? 'Start of Month');
  if (!['Start of Month', 'End of Month'].includes(accrualTiming)) {
    return 'Accrual timing must be Start of Month or End of Month.';
  }

  const creditDay = num(raw.creditDay ?? existing?.credit_day ?? 1);
  if (!Number.isInteger(creditDay) || creditDay < 1 || creditDay > 31) return 'Credit day must be between 1 and 31.';

  const numericFields: Array<[keyof typeof raw, number, string]> = [
    ['monthlyEntitlement', num(existing?.monthly_entitlement), 'Monthly entitlement'],
    ['annualEntitlement', num(existing?.annual_entitlement), 'Annual entitlement'],
    ['carryForwardCap', num(existing?.carry_forward_cap), 'Carry forward cap'],
    ['expiryMonths', num(existing?.expiry_months), 'Expiry months'],
    ['maxBalance', num(existing?.max_balance), 'Maximum balance'],
    ['probationMonths', num(existing?.probation_months), 'Probation months'],
  ];
  const numericValues: Record<string, number> = {};
  for (const [key, fallback, label] of numericFields) {
    const value = raw[key];
    const parsed = value === undefined || value === null || value === '' ? fallback : num(value);
    if (!Number.isFinite(parsed) || parsed < 0) return `${label} must be a non-negative number.`;
    numericValues[String(key)] = parsed;
  }
  if (!Number.isInteger(numericValues.expiryMonths) || !Number.isInteger(numericValues.probationMonths)) {
    return 'Expiry months and probation months must be whole numbers.';
  }

  const flagFields: Array<[keyof typeof raw, number, string]> = [
    ['prorateByJoiningDate', num(existing?.prorate_by_joining_date ?? 1), 'Prorate by joining date'],
    ['carryForward', num(existing?.carry_forward ?? 0), 'Carry forward'],
    ['fractionalSupport', num(existing?.fractional_support ?? 1), 'Fractional support'],
  ];
  const flagValues: Record<string, number> = {};
  for (const [key, fallback, label] of flagFields) {
    const value = raw[key];
    const parsed = value === undefined || value === null || value === '' ? fallback : num(value);
    if (parsed !== 0 && parsed !== 1) return `${label} must be 0 or 1.`;
    flagValues[String(key)] = parsed;
  }

  return {
    leaveType,
    accrualMethod,
    monthlyEntitlement: numericValues.monthlyEntitlement,
    annualEntitlement: numericValues.annualEntitlement,
    creditDay,
    accrualTiming,
    eligibility: String(raw.eligibility ?? existing?.eligibility ?? 'All Employees').trim() || 'All Employees',
    probationMonths: numericValues.probationMonths,
    prorateByJoiningDate: flagValues.prorateByJoiningDate,
    carryForward: flagValues.carryForward,
    carryForwardCap: numericValues.carryForwardCap,
    expiryMonths: numericValues.expiryMonths,
    maxBalance: numericValues.maxBalance,
    fractionalSupport: flagValues.fractionalSupport,
    effectiveFrom,
  };
}

export function createEnterpriseRoutes(db: ServerDatabase): Router {
  const router = Router();
  router.use(authenticateSession(db));
  router.use(requirePasswordChanged);

  function assertCompanyContext(req: AuthenticatedRequest, res: Response): string | null {
    const companyId = req.auth?.companyId;
    if (!companyId) {
      res.status(400).json({ error: 'Company context is required for this module.' });
      return null;
    }
    return companyId;
  }

  function audit(
    req: AuthenticatedRequest,
    action: string,
    targetType: string,
    targetId: string,
    details: string,
    outcome: 'success' | 'failure' | 'denied' = 'success'
  ): void {
    recordAuditLog(db, {
      companyId: req.auth?.companyId ?? null,
      actorUserId: req.auth?.userId ?? null,
      actorUsername: req.auth?.username ?? null,
      action,
      targetType,
      targetId,
      outcome,
      details,
      ipAddress: getClientIp(req),
    });
  }

  function blockCrossCompany(
    req: AuthenticatedRequest,
    res: Response,
    targetCompanyId: string | undefined,
    targetType: string,
    targetId: string
  ): boolean {
    if (!targetCompanyId) {
      res.status(404).json({ error: `${targetType} not found.` });
      return true;
    }
    if (targetCompanyId !== req.auth?.companyId) {
      audit(req, 'CROSS_TENANT_ACCESS_DENIED', targetType, targetId, `Blocked cross-company access to ${targetCompanyId}`, 'denied');
      res.status(403).json({
        error: 'Cross-company access is strictly prohibited.',
        code: 'CROSS_TENANT_FORBIDDEN',
      });
      return true;
    }
    return false;
  }

  function notifyUsers(
    companyId: string,
    userIds: string[],
    title: string,
    message: string,
    category: string
  ): void {
    const stmt = db.prepare(
      `INSERT INTO notifications (notification_id, company_id, user_id, title, message, category, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    );
    const createdAt = nowIso();
    for (const userId of [...new Set(userIds)]) {
      stmt.run(generateId('ntf'), companyId, userId, title, message, category, createdAt);
    }
  }

  function notifyAdmins(companyId: string, title: string, message: string, category: string, excludeUserId?: string): void {
    const roles = ADMIN_ROLES.map(() => '?').join(', ');
    const users = db
      .prepare(
        `SELECT u.user_id FROM users u
         JOIN roles r ON r.role_id = u.role_id
         WHERE u.company_id = ? AND r.role_name IN (${roles}) AND u.account_status = 'active'`
      )
      .all(companyId, ...ADMIN_ROLES) as Array<{ user_id: string }>;
    notifyUsers(
      companyId,
      users.map((row) => row.user_id).filter((userId) => userId !== excludeUserId),
      title,
      message,
      category
    );
  }

  function notifyEmployee(
    companyId: string,
    employeeRecordId: string,
    title: string,
    message: string,
    category: string
  ): void {
    const employee = db
      .prepare('SELECT user_id FROM employees WHERE employee_record_id = ? AND company_id = ?')
      .get(employeeRecordId, companyId) as { user_id: string } | undefined;
    if (employee) notifyUsers(companyId, [employee.user_id], title, message, category);
  }

  function resolveTargetEmployee(req: AuthenticatedRequest, res: Response, companyId: string): string | null {
    const auth = req.auth!;
    const requested = typeof req.query.employeeId === 'string' ? req.query.employeeId.trim() : '';
    if (!requested || requested === auth.employeeRecordId || requested === auth.employeeId) {
      if (!auth.employeeRecordId) {
        res.status(400).json({ error: 'Employee context is required for this module.' });
        return null;
      }
      return auth.employeeRecordId;
    }

    const target = db
      .prepare('SELECT employee_record_id, company_id FROM employees WHERE employee_record_id = ? OR employee_id = ?')
      .get(requested, requested) as { employee_record_id: string; company_id: string } | undefined;
    if (blockCrossCompany(req, res, target?.company_id, 'employee', requested)) return null;
    if (!APPROVER_ROLES.includes(auth.role)) {
      res.status(403).json({ error: 'Access denied. You may only view your own records.', code: 'FORBIDDEN_ROLE' });
      return null;
    }
    return target!.employee_record_id;
  }

  function rejectCrossCompanyShift(
    req: AuthenticatedRequest,
    res: Response,
    shiftId: string,
    companyId: string
  ): boolean {
    const shift = db.prepare('SELECT company_id FROM shifts WHERE shift_id = ?').get(shiftId) as
      | { company_id: string }
      | undefined;
    if (!shift) {
      res.status(400).json({ error: 'Invalid shift reference.', code: 'INVALID_REFERENCE' });
      return true;
    }
    return blockCrossCompany(req, res, shift.company_id, 'shift', shiftId);
  }

  router.get('/shift-change-requests', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const auth = req.auth!;
    const isApprover = APPROVER_ROLES.includes(auth.role);
    const params: unknown[] = [companyId];
    let employeeFilter = '';
    if (!isApprover) {
      if (!auth.employeeRecordId) {
        res.json({ requests: [], shiftChangeRequests: [] });
        return;
      }
      employeeFilter = 'AND r.employee_record_id = ?';
      params.push(auth.employeeRecordId);
    }

    const rows = db
      .prepare(
        `SELECT r.*, e.employee_name, e.employee_id, d.name AS department_name,
                sr.name AS requested_shift_name, sr.start_time AS requested_start_time,
                sr.end_time AS requested_end_time, sc.name AS current_shift_name
         FROM shift_change_requests r
         JOIN employees e ON e.employee_record_id = r.employee_record_id AND e.company_id = r.company_id
         JOIN shifts sr ON sr.shift_id = r.requested_shift_id
         LEFT JOIN shifts sc ON sc.shift_id = r.current_shift_id
         LEFT JOIN departments d ON d.department_id = e.department_id AND d.company_id = e.company_id
         WHERE r.company_id = ? ${employeeFilter}
         ORDER BY r.created_at DESC`
      )
      .all(...params) as Array<Record<string, unknown>>;

    const requests = rows.map((row) => ({
      ...row,
      conflicts: detectConflicts(
        db,
        companyId,
        String(row.employee_record_id),
        String(row.requested_shift_id),
        String(row.start_date),
        String(row.end_date),
        String(row.request_id)
      ),
    }));
    res.json({ requests, shiftChangeRequests: requests });
  });

  router.post('/shift-change-requests', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId || !req.auth?.employeeRecordId) return;

    const { requestedShiftId, startDate, endDate, reason } = req.body || {};
    const start = isoDate(startDate);
    const end = isoDate(endDate);
    if (!requestedShiftId || !start || !end || end < start || !String(reason || '').trim()) {
      res.status(400).json({ error: 'A valid shift, date range, and reason are required.' });
      return;
    }
    if (rejectCrossCompanyShift(req, res, String(requestedShiftId), companyId)) return;

    const employee = db
      .prepare(
        `SELECT assigned_shift_id, employee_name FROM employees
         WHERE employee_record_id = ? AND company_id = ?`
      )
      .get(req.auth.employeeRecordId, companyId) as
      | { assigned_shift_id: string | null; employee_name: string }
      | undefined;
    if (!employee) {
      res.status(404).json({ error: 'Employee record not found.' });
      return;
    }

    const conflicts = detectConflicts(
      db,
      companyId,
      req.auth.employeeRecordId,
      String(requestedShiftId),
      start,
      end
    );
    const requestId = generateId('scr');
    const now = nowIso();

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(
        `INSERT INTO shift_change_requests
          (request_id, company_id, employee_record_id, requested_shift_id, current_shift_id,
           start_date, end_date, reason, submission_date, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)`
      ).run(
        requestId,
        companyId,
        req.auth.employeeRecordId,
        String(requestedShiftId),
        employee.assigned_shift_id ?? null,
        start,
        end,
        String(reason).trim(),
        todayIso(),
        now,
        now
      );
      notifyAdmins(
        companyId,
        'Shift Change Request',
        `${employee.employee_name} requested a shift change from ${start} to ${end}.`,
        'Shift'
      );
      audit(req, 'SHIFT_CHANGE_REQUEST_CREATED', 'shift_change_request', requestId, `${start} to ${end}`);
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    res.status(201).json({ requestId, status: 'Pending', conflicts });
  });

  router.post('/shift-change-requests/:requestId/action', requireRoles(...APPROVER_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const request = db.prepare('SELECT * FROM shift_change_requests WHERE request_id = ?').get(req.params.requestId) as
      | Record<string, unknown>
      | undefined;
    if (blockCrossCompany(req, res, request?.company_id as string | undefined, 'shift_change_request', req.params.requestId)) {
      return;
    }

    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      res.status(400).json({ error: "Decision must be 'approve' or 'reject'." });
      return;
    }
    const comment = req.body?.comment ? String(req.body.comment).trim() : null;
    const approved = decision === 'approve';
    const conflicts = approved
      ? detectConflicts(
          db,
          companyId,
          String(request!.employee_record_id),
          String(request!.requested_shift_id),
          String(request!.start_date),
          String(request!.end_date),
          String(request!.request_id)
        )
      : [];
    if (approved && conflicts.length > 0) {
      audit(req, 'SHIFT_CHANGE_CONFLICT_DETECTED', 'shift_change_request', req.params.requestId, conflicts.join(' | '), 'failure');
      res.status(409).json({ error: 'Scheduling conflict detected.', conflicts });
      return;
    }

    const status = approved ? 'Approved' : 'Rejected';
    const now = nowIso();
    db.exec('BEGIN IMMEDIATE;');
    try {
      if (approved) {
        db.prepare(
          `INSERT INTO shift_schedule_overrides
            (override_id, company_id, employee_record_id, shift_id, start_date, end_date, request_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          generateId('ovr'),
          companyId,
          request!.employee_record_id,
          request!.requested_shift_id,
          request!.start_date,
          request!.end_date,
          request!.request_id,
          now
        );
        const today = todayIso();
        if (String(request!.end_date) >= today) {
          db.prepare(
            `UPDATE employees SET assigned_shift_id = ?
             WHERE employee_record_id = ? AND company_id = ?`
          ).run(request!.requested_shift_id, request!.employee_record_id, companyId);
        }
      }

      db.prepare(
        `UPDATE shift_change_requests
         SET status = ?, reviewed_by = ?, review_comment = ?, updated_at = ?
         WHERE request_id = ? AND company_id = ?`
      ).run(status, req.auth?.employeeRecordId ?? null, comment, now, request!.request_id, companyId);

      notifyEmployee(
        companyId,
        String(request!.employee_record_id),
        `Shift Change ${status}`,
        `Your shift change request from ${String(request!.start_date)} to ${String(request!.end_date)} was ${status.toLowerCase()}.`,
        'Shift'
      );
      audit(req, `SHIFT_CHANGE_REQUEST_${status.toUpperCase()}`, 'shift_change_request', String(request!.request_id), comment ?? '');
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    res.json({ ok: true, status, conflicts });
  });

  router.get('/shift-schedule', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const single = typeof req.query.date === 'string' ? isoDate(req.query.date) : null;
    const fromDate = single ?? (typeof req.query.fromDate === 'string' ? isoDate(req.query.fromDate) : null);
    const toDate = single ?? (typeof req.query.toDate === 'string' ? isoDate(req.query.toDate) : null);
    if (!fromDate || !toDate || toDate < fromDate) {
      res.status(400).json({ error: 'Provide a valid date or fromDate/toDate range (YYYY-MM-DD).' });
      return;
    }
    const employeeRecordId = resolveTargetEmployee(req, res, companyId);
    if (!employeeRecordId) return;

    const employee = db
      .prepare(
        `SELECT e.employee_id, e.employee_name, e.assigned_shift_id, s.name AS assigned_shift_name,
                s.start_time AS assigned_start_time, s.end_time AS assigned_end_time
         FROM employees e
         LEFT JOIN shifts s ON s.shift_id = e.assigned_shift_id
         WHERE e.employee_record_id = ? AND e.company_id = ?`
      )
      .get(employeeRecordId, companyId) as Record<string, unknown> | undefined;
    if (!employee) {
      res.status(404).json({ error: 'Employee not found.' });
      return;
    }

    const overrides = db
      .prepare(
        `SELECT o.override_id, o.shift_id, o.start_date, o.end_date, o.request_id,
                s.name AS shift_name, s.start_time, s.end_time
         FROM shift_schedule_overrides o
         JOIN shift_change_requests r
           ON r.request_id = o.request_id AND r.company_id = o.company_id AND r.status = 'Approved'
         JOIN shifts s ON s.shift_id = o.shift_id
         WHERE o.company_id = ? AND o.employee_record_id = ? AND o.start_date <= ? AND o.end_date >= ?
         ORDER BY o.start_date DESC`
      )
      .all(companyId, employeeRecordId, toDate, fromDate) as Array<Record<string, unknown>>;

    const first = overrides[0];
    const effectiveShift = first
      ? {
          shiftId: first.shift_id,
          name: first.shift_name,
          startTime: first.start_time,
          endTime: first.end_time,
          source: 'schedule_override',
        }
      : employee.assigned_shift_id
        ? {
            shiftId: employee.assigned_shift_id,
            name: employee.assigned_shift_name,
            startTime: employee.assigned_start_time,
            endTime: employee.assigned_end_time,
            source: 'assigned_shift',
          }
        : null;

    res.json({
      employeeId: employee.employee_id,
      employeeName: employee.employee_name,
      employeeRecordId,
      fromDate,
      toDate,
      effectiveShift,
      overrides,
    });
  });

  router.get('/expense-claims', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const auth = req.auth!;
    const isApprover = APPROVER_ROLES.includes(auth.role);
    const params: unknown[] = [companyId];
    let employeeFilter = '';
    if (!isApprover) {
      if (!auth.employeeRecordId) {
        res.json({ claims: [] });
        return;
      }
      employeeFilter = 'AND c.employee_record_id = ?';
      params.push(auth.employeeRecordId);
    }

    const claims = db
      .prepare(
        `SELECT c.*, e.employee_name, e.employee_id, d.name AS department_name
         FROM expense_claims c
         JOIN employees e ON e.employee_record_id = c.employee_record_id AND e.company_id = c.company_id
         LEFT JOIN departments d ON d.department_id = e.department_id AND d.company_id = e.company_id
         WHERE c.company_id = ? ${employeeFilter}
         ORDER BY c.created_at DESC`
      )
      .all(...params) as Array<Record<string, unknown>>;

    const claimIds = claims.map((row) => String(row.claim_id));
    const items = claimIds.length
      ? (db
          .prepare(
            `SELECT * FROM expense_items WHERE company_id = ? AND claim_id IN (${claimIds
              .map(() => '?')
              .join(', ')}) ORDER BY created_at ASC`
          )
          .all(companyId, ...claimIds) as Array<Record<string, unknown>>)
      : [];
    const itemsByClaim = new Map<string, Record<string, unknown>[]>();
    for (const item of items) {
      const claimId = String(item.claim_id);
      const list = itemsByClaim.get(claimId) ?? [];
      list.push(item);
      itemsByClaim.set(claimId, list);
    }

    res.json({ claims: claims.map((claim) => ({ ...claim, items: itemsByClaim.get(String(claim.claim_id)) ?? [] })) });
  });

  router.get('/expense-claims/:claimId', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const claim = db
      .prepare(
        `SELECT c.*, e.employee_name, e.employee_id, d.name AS department_name
         FROM expense_claims c
         JOIN employees e ON e.employee_record_id = c.employee_record_id AND e.company_id = c.company_id
         LEFT JOIN departments d ON d.department_id = e.department_id AND d.company_id = e.company_id
         WHERE c.claim_id = ?`
      )
      .get(req.params.claimId) as Record<string, unknown> | undefined;
    if (blockCrossCompany(req, res, claim?.company_id as string | undefined, 'expense_claim', req.params.claimId)) {
      return;
    }
    if (
      !APPROVER_ROLES.includes(req.auth!.role) &&
      String(claim!.employee_record_id) !== req.auth?.employeeRecordId
    ) {
      res.status(403).json({ error: 'Access denied. You may only view your own claims.', code: 'FORBIDDEN_ROLE' });
      return;
    }

    const items = db
      .prepare('SELECT * FROM expense_items WHERE company_id = ? AND claim_id = ? ORDER BY created_at ASC')
      .all(companyId, req.params.claimId) as Record<string, unknown>[];
    res.json({ claim, items });
  });

  router.post('/expense-claims', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId || !req.auth?.employeeRecordId) return;

    const { visitDate, location, client, businessPurpose, items } = req.body || {};
    const visit = isoDate(visitDate);
    if (!visit || !String(location || '').trim() || !String(client || '').trim() || !String(businessPurpose || '').trim()) {
      res.status(400).json({ error: 'Visit date, location, client, and business purpose are required.' });
      return;
    }
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'At least one expense item is required.' });
      return;
    }

    const parsedItems: Array<{
      category: string;
      amount: number;
      description: string;
      receiptFileName: string | null;
      receiptContentType: string | null;
      receiptDataUrl: string | null;
    }> = [];
    for (const raw of items) {
      const category = String(raw?.category || '');
      const amount = num(raw?.amount);
      const description = String(raw?.description || '').trim();
      if (!EXPENSE_CATEGORIES.includes(category)) {
        res.status(400).json({ error: 'Invalid expense category.' });
        return;
      }
      if (!Number.isFinite(amount) || amount <= 0 || !description) {
        res.status(400).json({ error: 'Each item needs a positive amount and a description.' });
        return;
      }
      const receiptDataUrl = raw?.receiptDataUrl == null || raw.receiptDataUrl === '' ? null : String(raw.receiptDataUrl);
      if (receiptDataUrl) {
        if (!receiptDataUrl.startsWith('data:') || !receiptDataUrl.includes(',')) {
          res.status(400).json({ error: 'Receipt must be a base64 data URL.' });
          return;
        }
        const base64 = receiptDataUrl.slice(receiptDataUrl.indexOf(',') + 1).replace(/\s/g, '');
        const decodedBytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
        if (!base64 || decodedBytes > MAX_RECEIPT_BYTES) {
          res.status(400).json({ error: 'Receipt data URL is empty or exceeds the 5MB limit.' });
          return;
        }
      }
      parsedItems.push({
        category,
        amount,
        description,
        receiptFileName: raw?.receiptFileName ? String(raw.receiptFileName) : null,
        receiptContentType: raw?.receiptContentType ? String(raw.receiptContentType) : null,
        receiptDataUrl,
      });
    }

    const totalAmount = Math.round(parsedItems.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
    const claimId = generateId('exp');
    const now = nowIso();
    const employee = db
      .prepare('SELECT employee_name FROM employees WHERE employee_record_id = ? AND company_id = ?')
      .get(req.auth.employeeRecordId, companyId) as { employee_name: string } | undefined;

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(
        `INSERT INTO expense_claims
          (claim_id, company_id, employee_record_id, visit_date, location, client, business_purpose,
           approval_status, payment_status, status, total_amount, submitted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', 'Unpaid', 'Pending', ?, ?, ?, ?)`
      ).run(
        claimId,
        companyId,
        req.auth.employeeRecordId,
        visit,
        String(location).trim(),
        String(client).trim(),
        String(businessPurpose).trim(),
        totalAmount,
        now,
        now,
        now
      );
      const insertItem = db.prepare(
        `INSERT INTO expense_items
          (item_id, company_id, claim_id, category, amount, description,
           receipt_file_name, receipt_content_type, receipt_data_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of parsedItems) {
        insertItem.run(
          generateId('item'),
          companyId,
          claimId,
          item.category,
          item.amount,
          item.description,
          item.receiptFileName,
          item.receiptContentType,
          item.receiptDataUrl,
          now
        );
      }
      notifyAdmins(
        companyId,
        'Expense Claim Submitted',
        `${employee?.employee_name ?? 'An employee'} submitted an expense claim for ${totalAmount}.`,
        'Expense'
      );
      audit(req, 'EXPENSE_CLAIM_CREATED', 'expense_claim', claimId, `total=${totalAmount}`);
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    res.status(201).json({ claimId, status: 'Pending', totalAmount });
  });

  router.post('/expense-claims/:claimId/action', requireRoles(...APPROVER_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const claim = db
      .prepare('SELECT * FROM expense_claims WHERE claim_id = ?')
      .get(req.params.claimId) as Record<string, unknown> | undefined;
    if (blockCrossCompany(req, res, claim?.company_id as string | undefined, 'expense_claim', req.params.claimId)) {
      return;
    }
    if (String(claim!.status) === 'Paid') {
      res.status(409).json({ error: 'Paid claims cannot be reviewed again.' });
      return;
    }

    const decisionByMap: Record<string, string> = {
      approve: 'Approved',
      reject: 'Rejected',
      'request-info': 'Needs Info',
    };
    const approvalStatus = decisionByMap[String(req.body?.decision)];
    if (!approvalStatus) {
      res.status(400).json({ error: "Decision must be 'approve', 'reject', or 'request-info'." });
      return;
    }
    const comment = req.body?.comment ? String(req.body.comment).trim() : null;
    const now = nowIso();

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(
        `UPDATE expense_claims
         SET approval_status = ?, status = ?, reviewed_by = ?, review_comment = ?, reviewed_at = ?, updated_at = ?
         WHERE claim_id = ? AND company_id = ?`
      ).run(
        approvalStatus,
        approvalStatus,
        req.auth?.employeeRecordId ?? null,
        comment,
        now,
        now,
        claim!.claim_id,
        companyId
      );
      notifyEmployee(
        companyId,
        String(claim!.employee_record_id),
        `Expense Claim ${approvalStatus}`,
        `Your expense claim was marked ${approvalStatus}${comment ? `: ${comment}` : '.'}`,
        'Expense'
      );
      audit(req, `EXPENSE_CLAIM_${approvalStatus.replace(/\s+/g, '_').toUpperCase()}`, 'expense_claim', String(claim!.claim_id), comment ?? '');
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    res.json({ ok: true, approvalStatus, status: approvalStatus });
  });

  router.post('/expense-claims/:claimId/pay', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const claim = db
      .prepare('SELECT * FROM expense_claims WHERE claim_id = ?')
      .get(req.params.claimId) as Record<string, unknown> | undefined;
    if (blockCrossCompany(req, res, claim?.company_id as string | undefined, 'expense_claim', req.params.claimId)) {
      return;
    }
    if (String(claim!.approval_status) !== 'Approved') {
      res.status(409).json({ error: 'Only approved claims can be paid.' });
      return;
    }
    if (String(claim!.payment_status) === 'Paid') {
      res.status(409).json({ error: 'This claim has already been paid.' });
      return;
    }

    const comment = req.body?.comment ? String(req.body.comment).trim() : null;
    const now = nowIso();
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(
        `UPDATE expense_claims
         SET payment_status = 'Paid', status = 'Paid', paid_by = ?, paid_at = ?,
             review_comment = COALESCE(?, review_comment), updated_at = ?
         WHERE claim_id = ? AND company_id = ?`
      ).run(req.auth?.employeeRecordId ?? null, now, comment, now, claim!.claim_id, companyId);
      notifyEmployee(
        companyId,
        String(claim!.employee_record_id),
        'Expense Claim Paid',
        `Your expense claim for ${num(claim!.total_amount)} has been marked as paid.`,
        'Expense'
      );
      audit(req, 'EXPENSE_CLAIM_PAID', 'expense_claim', String(claim!.claim_id), comment ?? '');
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    res.json({ ok: true, paymentStatus: 'Paid', status: 'Paid' });
  });

  router.get('/expense-reports', requireRoles(...APPROVER_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const groupBy = req.query.groupBy === 'department' ? 'department' : 'employee';
    const from = typeof req.query.fromDate === 'string' ? isoDate(req.query.fromDate) : null;
    const to = typeof req.query.toDate === 'string' ? isoDate(req.query.toDate) : null;
    if ((req.query.fromDate && !from) || (req.query.toDate && !to) || (from && to && to < from)) {
      res.status(400).json({ error: 'Invalid report date range.' });
      return;
    }
    const params: unknown[] = [companyId];
    let dateFilter = '';
    if (from) {
      dateFilter += ' AND c.visit_date >= ?';
      params.push(from);
    }
    if (to) {
      dateFilter += ' AND c.visit_date <= ?';
      params.push(to);
    }

    const groupExpression =
      groupBy === 'department' ? "COALESCE(d.name, 'Unassigned')" : 'e.employee_name';
    const rows = db
      .prepare(
        `SELECT ${groupExpression} AS group_name, COUNT(c.claim_id) AS claim_count,
                COALESCE(SUM(c.total_amount), 0) AS total_amount
         FROM expense_claims c
         JOIN employees e ON e.employee_record_id = c.employee_record_id AND e.company_id = c.company_id
         LEFT JOIN departments d ON d.department_id = e.department_id AND d.company_id = e.company_id
         WHERE c.company_id = ? AND c.approval_status = 'Approved' ${dateFilter}
         GROUP BY ${groupExpression}
         ORDER BY total_amount DESC`
      )
      .all(...params) as Array<Record<string, unknown>>;
    const totals = db
      .prepare(
        `SELECT COUNT(c.claim_id) AS claim_count, COALESCE(SUM(c.total_amount), 0) AS total_amount
         FROM expense_claims c
         WHERE c.company_id = ? AND c.approval_status = 'Approved' ${dateFilter}`
      )
      .get(...params) as Record<string, unknown>;

    res.json({
      rows: rows.map((row) => ({
        groupBy,
        name: row.group_name,
        employeeName: groupBy === 'employee' ? row.group_name : null,
        departmentName: groupBy === 'department' ? row.group_name : null,
        claimCount: num(row.claim_count),
        totalAmount: num(row.total_amount),
      })),
      totals: { claimCount: num(totals.claim_count), totalAmount: num(totals.total_amount) },
    });
  });

  router.get('/leave-policies', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const policies = getActivePolicies(db, companyId);
    const history = db
      .prepare(
        `SELECT * FROM leave_policy_history WHERE company_id = ? ORDER BY changed_at DESC LIMIT 100`
      )
      .all(companyId) as Record<string, unknown>[];
    res.json({ policies, history });
  });

  router.post('/leave-policies', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const parsed = parsePolicyInput(req.body || {});
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }
    const duplicate = db
      .prepare(
        `SELECT policy_id FROM leave_policies WHERE company_id = ? AND leave_type = ? AND effective_from = ?`
      )
      .get(companyId, parsed.leaveType, parsed.effectiveFrom);
    if (duplicate) {
      res.status(409).json({ error: 'A policy already exists for this leave type and effective date.' });
      return;
    }

    const policyId = generateId('pol');
    const now = nowIso();
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(
        `INSERT INTO leave_policies
          (policy_id, company_id, leave_type, accrual_method, monthly_entitlement, annual_entitlement,
           credit_day, accrual_timing, eligibility, probation_months, prorate_by_joining_date,
           carry_forward, carry_forward_cap, expiry_months, max_balance, fractional_support,
           is_active, effective_from, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).run(
        policyId,
        companyId,
        parsed.leaveType,
        parsed.accrualMethod,
        parsed.monthlyEntitlement,
        parsed.annualEntitlement,
        parsed.creditDay,
        parsed.accrualTiming,
        parsed.eligibility,
        parsed.probationMonths,
        parsed.prorateByJoiningDate,
        parsed.carryForward,
        parsed.carryForwardCap,
        parsed.expiryMonths,
        parsed.maxBalance,
        parsed.fractionalSupport,
        parsed.effectiveFrom,
        now,
        now
      );
      const policy = db.prepare('SELECT * FROM leave_policies WHERE policy_id = ?').get(policyId);
      db.prepare(
        `INSERT INTO leave_policy_history
          (history_id, company_id, policy_id, action, snapshot_json, changed_by, changed_at)
         VALUES (?, ?, ?, 'CREATED', ?, ?, ?)`
      ).run(generateId('phist'), companyId, policyId, JSON.stringify(policy), req.auth?.employeeRecordId ?? null, now);
      audit(req, 'LEAVE_POLICY_CREATED', 'leave_policy', policyId, `${parsed.leaveType} (${parsed.accrualMethod})`);
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    res.status(201).json({ policyId });
  });

  router.put('/leave-policies/:policyId', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const existing = db.prepare('SELECT * FROM leave_policies WHERE policy_id = ?').get(req.params.policyId) as
      | LeavePolicyRow
      | undefined;
    if (blockCrossCompany(req, res, existing?.company_id, 'leave_policy', req.params.policyId)) return;

    const parsed = parsePolicyInput(req.body || {}, existing);
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }

    let effectiveFrom = parsed.effectiveFrom;
    const ledgerRef = db
      .prepare('SELECT ledger_id FROM leave_ledger WHERE company_id = ? AND policy_id = ? LIMIT 1')
      .get(companyId, existing!.policy_id);
    const supersede = Boolean(ledgerRef);
    if (supersede && parsed.effectiveFrom <= String(existing!.effective_from)) {
      const next = new Date(`${todayIso()}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      effectiveFrom = next.toISOString().slice(0, 10);
    }
    const duplicate = db
      .prepare(
        `SELECT policy_id FROM leave_policies
         WHERE company_id = ? AND leave_type = ? AND effective_from = ? AND policy_id <> ?`
      )
      .get(companyId, parsed.leaveType, effectiveFrom, existing!.policy_id);
    if (duplicate) {
      res.status(409).json({ error: 'A policy already exists for this leave type and effective date.' });
      return;
    }

    const now = nowIso();
    let finalPolicyId = existing!.policy_id;
    db.exec('BEGIN IMMEDIATE;');
    try {
      if (supersede) {
        finalPolicyId = generateId('pol');
        db.prepare('UPDATE leave_policies SET is_active = 0, updated_at = ? WHERE policy_id = ? AND company_id = ?').run(
          now,
          existing!.policy_id,
          companyId
        );
        db.prepare(
          `INSERT INTO leave_policies
            (policy_id, company_id, leave_type, accrual_method, monthly_entitlement, annual_entitlement,
             credit_day, accrual_timing, eligibility, probation_months, prorate_by_joining_date,
             carry_forward, carry_forward_cap, expiry_months, max_balance, fractional_support,
             is_active, effective_from, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        ).run(
          finalPolicyId,
          companyId,
          parsed.leaveType,
          parsed.accrualMethod,
          parsed.monthlyEntitlement,
          parsed.annualEntitlement,
          parsed.creditDay,
          parsed.accrualTiming,
          parsed.eligibility,
          parsed.probationMonths,
          parsed.prorateByJoiningDate,
          parsed.carryForward,
          parsed.carryForwardCap,
          parsed.expiryMonths,
          parsed.maxBalance,
          parsed.fractionalSupport,
          effectiveFrom,
          now,
          now
        );
      } else {
        db.prepare(
          `UPDATE leave_policies
           SET leave_type = ?, accrual_method = ?, monthly_entitlement = ?, annual_entitlement = ?,
               credit_day = ?, accrual_timing = ?, eligibility = ?, probation_months = ?,
               prorate_by_joining_date = ?, carry_forward = ?, carry_forward_cap = ?, expiry_months = ?,
               max_balance = ?, fractional_support = ?, effective_from = ?, updated_at = ?
           WHERE policy_id = ? AND company_id = ?`
        ).run(
          parsed.leaveType,
          parsed.accrualMethod,
          parsed.monthlyEntitlement,
          parsed.annualEntitlement,
          parsed.creditDay,
          parsed.accrualTiming,
          parsed.eligibility,
          parsed.probationMonths,
          parsed.prorateByJoiningDate,
          parsed.carryForward,
          parsed.carryForwardCap,
          parsed.expiryMonths,
          parsed.maxBalance,
          parsed.fractionalSupport,
          effectiveFrom,
          now,
          existing!.policy_id,
          companyId
        );
      }
      const updated = db.prepare('SELECT * FROM leave_policies WHERE policy_id = ?').get(finalPolicyId);
      db.prepare(
        `INSERT INTO leave_policy_history
          (history_id, company_id, policy_id, action, snapshot_json, changed_by, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        generateId('phist'),
        companyId,
        finalPolicyId,
        supersede ? 'SUPERSEDED' : 'UPDATED',
        JSON.stringify(updated),
        req.auth?.employeeRecordId ?? null,
        now
      );
      audit(
        req,
        supersede ? 'LEAVE_POLICY_SUPERSEDED' : 'LEAVE_POLICY_UPDATED',
        'leave_policy',
        finalPolicyId,
        supersede ? `Superseded ${existing!.policy_id}` : parsed.leaveType
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    res.json({ policyId: finalPolicyId });
  });

  router.post('/leave-policies/:policyId/accrue', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;

    const policy = db.prepare('SELECT * FROM leave_policies WHERE policy_id = ?').get(req.params.policyId) as
      | LeavePolicyRow
      | undefined;
    if (blockCrossCompany(req, res, policy?.company_id, 'leave_policy', req.params.policyId)) return;

    const period = monthPeriod(req.body?.period ?? undefined);
    if (!period) {
      res.status(400).json({ error: 'Period must be in YYYY-MM format.' });
      return;
    }
    const rawIds = req.body?.employeeIds;
    let employeeIds: string[];
    if (rawIds === undefined || rawIds === null) {
      const activeEmployees = db
        .prepare(`SELECT employee_record_id FROM employees WHERE company_id = ? AND employment_status = 'active'`)
        .all(companyId) as Array<{ employee_record_id: string }>;
      employeeIds = activeEmployees.map((row) => row.employee_record_id);
    } else {
      if (!Array.isArray(rawIds)) {
        res.status(400).json({ error: 'employeeIds must be an array.' });
        return;
      }
      employeeIds = [];
      for (const rawId of rawIds) {
        const employeeRecordId = String(rawId).trim();
        if (!employeeRecordId) continue;
        const employee = db
          .prepare('SELECT company_id FROM employees WHERE employee_record_id = ?')
          .get(employeeRecordId) as { company_id: string } | undefined;
        if (blockCrossCompany(req, res, employee?.company_id, 'employee', employeeRecordId)) return;
        employeeIds.push(employeeRecordId);
      }
    }

    const credits: string[] = [];
    const skipped: string[] = [];
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const employeeRecordId of employeeIds) {
        const result = runAccrualForEmployee(
          db,
          companyId,
          employeeRecordId,
          period,
          req.auth?.fullName ?? req.auth?.username ?? 'Administrator',
          policy!.policy_id
        );
        credits.push(...result.credits.map((entry) => `${employeeRecordId}: ${entry}`));
        skipped.push(...result.skipped.map((entry) => `${employeeRecordId}: ${entry}`));
      }
      audit(req, 'LEAVE_ACCRUAL_RUN', 'leave_policy', policy!.policy_id, `period=${period} employees=${employeeIds.length}`);
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    res.json({ credits, skipped });
  });

  router.post('/leave-policies/accrue-current', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId || !req.auth?.employeeRecordId) return;

    db.exec('BEGIN IMMEDIATE;');
    try {
      ensureCurrentPeriodAccrual(db, companyId, req.auth.employeeRecordId);
      audit(req, 'LEAVE_ACCRUAL_CURRENT', 'employee', req.auth.employeeRecordId, 'Current period accrual check');
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    res.json({ ok: true });
  });

  router.get('/leave-overview', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const employeeRecordId = resolveTargetEmployee(req, res, companyId);
    if (!employeeRecordId) return;

    db.exec('BEGIN IMMEDIATE;');
    try {
      ensureCurrentPeriodAccrual(db, companyId, employeeRecordId);
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    res.json({ employeeRecordId, ...getLeaveOverview(db, companyId, employeeRecordId) });
  });

  router.get('/leave-ledger', (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const employeeRecordId = resolveTargetEmployee(req, res, companyId);
    if (!employeeRecordId) return;

    const params: unknown[] = [companyId, employeeRecordId];
    let leaveTypeFilter = '';
    if (typeof req.query.leaveType === 'string' && req.query.leaveType.trim()) {
      leaveTypeFilter = 'AND leave_type = ?';
      params.push(req.query.leaveType.trim());
    }
    const ledger = db
      .prepare(
        `SELECT * FROM leave_ledger
         WHERE company_id = ? AND employee_record_id = ? ${leaveTypeFilter}
         ORDER BY effective_date DESC, created_at DESC LIMIT 100`
      )
      .all(...params) as Record<string, unknown>[];
    res.json({ ledger });
  });

  router.get('/shift-change-requests/:requestId', requireRoles(...APPROVER_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const request = db
      .prepare('SELECT * FROM shift_change_requests WHERE request_id = ?')
      .get(req.params.requestId) as Record<string, unknown> | undefined;
    if (blockCrossCompany(req, res, request?.company_id as string | undefined, 'shift_change_request', req.params.requestId)) {
      return;
    }
    res.json({
      request,
      conflicts: detectConflicts(
        db,
        companyId,
        String(request!.employee_record_id),
        String(request!.requested_shift_id),
        String(request!.start_date),
        String(request!.end_date),
        String(request!.request_id)
      ),
    });
  });

  router.get('/leave-policy-history', requireRoles(...ADMIN_ROLES), (req: AuthenticatedRequest, res) => {
    const companyId = assertCompanyContext(req, res);
    if (!companyId) return;
    const history = db
      .prepare(
        `SELECT * FROM leave_policy_history WHERE company_id = ? ORDER BY changed_at DESC LIMIT 100`
      )
      .all(companyId) as Record<string, unknown>[];
    res.json({ history });
  });

  return router;
}
