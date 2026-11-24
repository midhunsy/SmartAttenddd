import type { ServerDatabase } from '../postgres.ts';
import { generateId } from '../auth.ts';

export type LeaveEntryType =
  | 'Accrual'
  | 'Annual Allocation'
  | 'Carry Forward'
  | 'Expiry'
  | 'Deduction'
  | 'Adjustment';

export interface LeavePolicyRow {
  policy_id: string;
  company_id: string;
  leave_type: string;
  accrual_method: string;
  monthly_entitlement: number;
  annual_entitlement: number;
  credit_day: number;
  accrual_timing: string;
  eligibility: string;
  probation_months: number;
  prorate_by_joining_date: number;
  carry_forward: number;
  carry_forward_cap: number;
  expiry_months: number;
  max_balance: number;
  fractional_support: number;
  is_active: number;
  effective_from: string;
  created_at: string;
  updated_at: string;
}

export interface LedgerEntryParams {
  companyId: string;
  employeeRecordId: string;
  leaveType: string;
  entryType: LeaveEntryType;
  days: number;
  policyId?: string | null;
  period: string;
  effectiveDate: string;
  referenceId: string;
  description: string;
}

interface BalanceRow {
  balance_id: string;
  total_days: number;
  used_days: number;
  current_balance: number | null;
  accrued_days: number | null;
  carry_forward_days: number | null;
  expired_days: number | null;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function nowIso(): string {
  return new Date().toISOString();
}

function currentPeriod(): { period: string; date: string } {
  const now = new Date();
  return {
    period: `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`,
    date: `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`,
  };
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function monthLength(period: string): number {
  const [year, month] = period.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return 30;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonths(date: string, months: number): string {
  if (!isValidIsoDate(date)) return date;
  const [year, month, day] = date.split('-').map(Number);
  const total = year * 12 + month - 1 + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = (total % 12) + 1;
  const targetDay = Math.min(day, new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate());
  return `${targetYear}-${pad2(targetMonth)}-${pad2(targetDay)}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function getActivePolicies(db: ServerDatabase, companyId: string): LeavePolicyRow[] {
  return db
    .prepare(
      `SELECT * FROM leave_policies WHERE company_id = ? AND is_active = 1 ORDER BY leave_type ASC, effective_from DESC`
    )
    .all(companyId) as LeavePolicyRow[];
}

export function getPolicyForType(
  db: ServerDatabase,
  companyId: string,
  leaveType: string
): LeavePolicyRow | undefined {
  return db
    .prepare(
      `SELECT * FROM leave_policies WHERE company_id = ? AND leave_type = ? AND is_active = 1 ORDER BY effective_from DESC LIMIT 1`
    )
    .get(companyId, leaveType) as LeavePolicyRow | undefined;
}

export function calculateAccrualDays(policy: LeavePolicyRow, joiningDate: string, period: string): number {
  if (!/^\d{4}-\d{2}$/.test(period)) return 0;
  const [year, month] = period.split('-').map(Number);
  const periodStart = `${period}-01`;
  const probationMonths = Math.max(0, num(policy.probation_months));
  if (probationMonths > 0) {
    const eligibilityDate = addMonths(joiningDate, probationMonths);
    if (isValidIsoDate(eligibilityDate) && eligibilityDate > periodStart) return 0;
  }

  const joining = isValidIsoDate(joiningDate) ? joiningDate : '';
  const prorate = num(policy.prorate_by_joining_date) === 1;
  let days = 0;

  if (policy.accrual_method === 'Monthly') {
    const totalDays = monthLength(period);
    days = num(policy.monthly_entitlement);
    if (prorate && joining && joining.slice(0, 7) === period) {
      const joiningDay = num(joining.slice(8, 10));
      days = ((totalDays - joiningDay + 1) / totalDays) * days;
    }
  } else {
    days = num(policy.annual_entitlement);
    if (prorate && joining && joining.slice(0, 4) === String(year)) {
      const joiningMonth = num(joining.slice(5, 7));
      const remainingMonths = Math.max(0, Math.min(12, 13 - joiningMonth));
      days = (days * remainingMonths) / 12;
    }
  }

  if (num(policy.fractional_support) !== 1) days = Math.floor(days);
  return round2(Math.max(0, days));
}

export function ensureBalanceRow(
  db: ServerDatabase,
  companyId: string,
  employeeRecordId: string,
  leaveType: string,
  year: number
): void {
  const existing = db
    .prepare(
      `SELECT balance_id, total_days, used_days, current_balance FROM leave_balances
       WHERE company_id = ? AND employee_record_id = ? AND leave_type = ? AND year = ?`
    )
    .get(companyId, employeeRecordId, leaveType, year) as BalanceRow | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO leave_balances
        (balance_id, company_id, employee_record_id, leave_type, total_days, used_days, year,
         current_balance, accrued_days, carry_forward_days, expired_days, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, 0, 0, 0, 0, ?)`
    ).run(generateId('bal'), companyId, employeeRecordId, leaveType, year, nowIso());
    return;
  }

  const legacyBalance = Math.max(0, num(existing.total_days) - num(existing.used_days));
  const hasLedger = db
    .prepare(
      `SELECT ledger_id FROM leave_ledger WHERE company_id = ? AND employee_record_id = ? AND leave_type = ? LIMIT 1`
    )
    .get(companyId, employeeRecordId, leaveType);
  if (num(existing.current_balance) === 0 && legacyBalance > 0 && !hasLedger) {
    db.prepare(`UPDATE leave_balances SET current_balance = ?, updated_at = ? WHERE balance_id = ?`).run(
      legacyBalance,
      nowIso(),
      existing.balance_id
    );
  }
}

export function appendLedgerEntry(db: ServerDatabase, params: LedgerEntryParams): void {
  const duplicate = db
    .prepare(
      `SELECT ledger_id FROM leave_ledger
       WHERE company_id = ? AND employee_record_id = ? AND leave_type = ? AND reference_id = ?`
    )
    .get(params.companyId, params.employeeRecordId, params.leaveType, params.referenceId);
  if (duplicate) return;

  const year = Number.parseInt(params.period.slice(0, 4), 10);
  ensureBalanceRow(db, params.companyId, params.employeeRecordId, params.leaveType, year);

  const balance = db
    .prepare(
      `SELECT balance_id, current_balance, accrued_days, carry_forward_days, expired_days
       FROM leave_balances
       WHERE company_id = ? AND employee_record_id = ? AND leave_type = ? AND year = ?`
    )
    .get(params.companyId, params.employeeRecordId, params.leaveType, year) as BalanceRow | undefined;
  if (!balance) return;

  const current = num(balance.current_balance);
  let delta = num(params.days);
  if (delta > 0 && params.policyId) {
    const policy = db.prepare('SELECT max_balance FROM leave_policies WHERE policy_id = ? AND company_id = ?').get(
      params.policyId,
      params.companyId
    ) as { max_balance: number } | undefined;
    const maxBalance = num(policy?.max_balance);
    if (maxBalance > 0) delta = Math.min(delta, Math.max(0, maxBalance - current));
  }

  const nextBalance = Math.max(0, round2(current + delta));
  const appliedDelta = round2(nextBalance - current);
  const accrued = num(balance.accrued_days);
  const carried = num(balance.carry_forward_days);
  const expired = num(balance.expired_days);
  const nextAccrued =
    params.entryType === 'Accrual' || params.entryType === 'Annual Allocation'
      ? round2(accrued + appliedDelta)
      : accrued;
  const nextCarried = params.entryType === 'Carry Forward' ? round2(carried + appliedDelta) : carried;
  const nextExpired = params.entryType === 'Expiry' ? round2(expired + Math.abs(appliedDelta)) : expired;

  db.prepare(
    `INSERT INTO leave_ledger
      (ledger_id, company_id, employee_record_id, leave_type, entry_type, days, balance_after,
       policy_id, period, effective_date, reference_id, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    generateId('led'),
    params.companyId,
    params.employeeRecordId,
    params.leaveType,
    params.entryType,
    appliedDelta,
    nextBalance,
    params.policyId ?? null,
    params.period,
    params.effectiveDate,
    params.referenceId,
    params.description,
    nowIso()
  );

  db.prepare(
    `UPDATE leave_balances
     SET current_balance = ?, accrued_days = ?, carry_forward_days = ?, expired_days = ?, updated_at = ?
     WHERE balance_id = ?`
  ).run(nextBalance, nextAccrued, nextCarried, nextExpired, nowIso(), balance.balance_id);
}

export function runAccrualForEmployee(
  db: ServerDatabase,
  companyId: string,
  employeeRecordId: string,
  period: string,
  actorName?: string,
  policyIdFilter?: string
): { credits: string[]; skipped: string[] } {
  const credits: string[] = [];
  const skipped: string[] = [];
  const employee = db
    .prepare(
      `SELECT employee_name, joining_date, employment_status FROM employees
       WHERE employee_record_id = ? AND company_id = ?`
    )
    .get(employeeRecordId, companyId) as
    | { employee_name: string; joining_date: string; employment_status: string }
    | undefined;
  if (!employee) {
    skipped.push('Employee not found.');
    return { credits, skipped };
  }
  if (employee.employment_status !== 'active') {
    skipped.push(`${employee.employee_name}: employee is not active.`);
    return { credits, skipped };
  }
  if (!/^\d{4}-\d{2}$/.test(period)) {
    skipped.push('Invalid accrual period.');
    return { credits, skipped };
  }

  const policies = policyIdFilter
    ? (db
        .prepare(
          `SELECT * FROM leave_policies
           WHERE company_id = ? AND policy_id = ? AND is_active = 1`
        )
        .all(companyId, policyIdFilter) as LeavePolicyRow[])
    : getActivePolicies(db, companyId);
  const year = Number(period.slice(0, 4));
  const month = num(period.slice(5, 7));
  const lastDay = monthLength(period);
  const actor = actorName || 'System';

  for (const policy of policies) {
    if (period < String(policy.effective_from).slice(0, 7)) {
      skipped.push(`${policy.leave_type}: policy is not effective for ${period}.`);
      continue;
    }
    const isAnnual = policy.accrual_method === 'Annual';
    if (isAnnual && month !== 1) {
      skipped.push(`${policy.leave_type}: annual policies accrue in January only.`);
      continue;
    }

    const referenceId = isAnnual
      ? `${policy.policy_id}:ACCRUAL:${year}`
      : `${policy.policy_id}:ACCRUAL:${period}`;
    const duplicate = db
      .prepare(
        `SELECT ledger_id FROM leave_ledger
         WHERE company_id = ? AND employee_record_id = ? AND leave_type = ? AND reference_id = ?`
      )
      .get(companyId, employeeRecordId, policy.leave_type, referenceId);
    if (duplicate) {
      skipped.push(`${policy.leave_type}: already accrued for ${period}.`);
      continue;
    }

    const days = calculateAccrualDays(policy, employee.joining_date, period);
    if (days <= 0) {
      skipped.push(`${policy.leave_type}: not eligible for ${period}.`);
      continue;
    }

    const creditDay = Math.max(1, Math.min(lastDay, num(policy.credit_day) || 1));
    const effectiveDate =
      policy.accrual_timing === 'End of Month'
        ? `${period}-${pad2(lastDay)}`
        : `${period}-${pad2(creditDay)}`;

    appendLedgerEntry(db, {
      companyId,
      employeeRecordId,
      leaveType: policy.leave_type,
      entryType: isAnnual ? 'Annual Allocation' : 'Accrual',
      days,
      policyId: policy.policy_id,
      period,
      effectiveDate,
      referenceId,
      description: `${actor} credited ${days} ${policy.leave_type} day(s) for ${period}.`,
    });
    credits.push(`${policy.leave_type}: credited ${days} day(s) for ${period}.`);

    if (num(policy.carry_forward) === 1 && month === 1) {
      const carryReference = `${policy.policy_id}:CF:${year}`;
      const carryDuplicate = db
        .prepare(
          `SELECT ledger_id FROM leave_ledger
           WHERE company_id = ? AND employee_record_id = ? AND leave_type = ? AND reference_id = ?`
        )
        .get(companyId, employeeRecordId, policy.leave_type, carryReference);
      if (!carryDuplicate) {
        const previous = db
          .prepare(
            `SELECT current_balance, total_days, used_days FROM leave_balances
             WHERE company_id = ? AND employee_record_id = ? AND leave_type = ? AND year = ?`
          )
          .get(companyId, employeeRecordId, policy.leave_type, year - 1) as
          | { current_balance: number | null; total_days: number; used_days: number }
          | undefined;
        const previousBalance = previous
          ? Math.max(
              0,
              num(previous.current_balance) > 0
                ? num(previous.current_balance)
                : num(previous.total_days) - num(previous.used_days)
            )
          : 0;
        const cap = num(policy.carry_forward_cap);
        const carryDays = round2(cap > 0 ? Math.min(previousBalance, cap) : previousBalance);
        if (carryDays > 0) {
          appendLedgerEntry(db, {
            companyId,
            employeeRecordId,
            leaveType: policy.leave_type,
            entryType: 'Carry Forward',
            days: carryDays,
            policyId: policy.policy_id,
            period,
            effectiveDate: `${year}-01-01`,
            referenceId: carryReference,
            description: `${actor} carried forward ${carryDays} ${policy.leave_type} day(s) from ${year - 1}.`,
          });
          credits.push(`${policy.leave_type}: carried forward ${carryDays} day(s) from ${year - 1}.`);
        }
      }
    }

    if (num(policy.expiry_months) > 0) {
      const expiryReference = `${policy.policy_id}:EXPIRY:${period}`;
      const expiryDuplicate = db
        .prepare(
          `SELECT ledger_id FROM leave_ledger
           WHERE company_id = ? AND employee_record_id = ? AND leave_type = ? AND reference_id = ?`
        )
        .get(companyId, employeeRecordId, policy.leave_type, expiryReference);
      if (!expiryDuplicate) {
        const cutoff = addMonths(`${period}-01`, -num(policy.expiry_months));
        const older = db
          .prepare(
            `SELECT COALESCE(SUM(days), 0) AS total FROM leave_ledger
             WHERE company_id = ? AND employee_record_id = ? AND leave_type = ? AND policy_id = ?
               AND days > 0 AND effective_date < ?`
          )
          .get(companyId, employeeRecordId, policy.leave_type, policy.policy_id, cutoff) as { total: number };
        const alreadyExpired = db
          .prepare(
            `SELECT COALESCE(SUM(ABS(days)), 0) AS total FROM leave_ledger
             WHERE company_id = ? AND employee_record_id = ? AND leave_type = ? AND policy_id = ?
               AND reference_id LIKE ?`
          )
          .get(companyId, employeeRecordId, policy.leave_type, policy.policy_id, `${policy.policy_id}:EXPIRY:%`) as {
          total: number;
        };
        const balanceRow = db
          .prepare(
            `SELECT current_balance FROM leave_balances
             WHERE company_id = ? AND employee_record_id = ? AND leave_type = ? AND year = ?`
          )
          .get(companyId, employeeRecordId, policy.leave_type, year) as { current_balance: number | null } | undefined;
        const expiryDays = round2(
          Math.min(Math.max(0, num(older.total) - num(alreadyExpired.total)), Math.max(0, num(balanceRow?.current_balance)))
        );
        if (expiryDays > 0) {
          appendLedgerEntry(db, {
            companyId,
            employeeRecordId,
            leaveType: policy.leave_type,
            entryType: 'Expiry',
            days: -expiryDays,
            policyId: policy.policy_id,
            period,
            effectiveDate: `${period}-${pad2(lastDay)}`,
            referenceId: expiryReference,
            description: `${actor} expired ${expiryDays} ${policy.leave_type} day(s) for ${period}.`,
          });
          credits.push(`${policy.leave_type}: expired ${expiryDays} day(s) for ${period}.`);
        }
      }
    }
  }

  return { credits, skipped };
}

export function ensureCurrentPeriodAccrual(
  db: ServerDatabase,
  companyId: string,
  employeeRecordId: string
): void {
  const { period, date } = currentPeriod();
  const today = num(date.slice(8, 10));
  const lastDay = monthLength(period);
  const policies = getActivePolicies(db, companyId);
  const shouldRun = policies.some(
    (policy) => num(policy.credit_day) <= today || (policy.accrual_timing === 'End of Month' && today === lastDay)
  );
  if (!shouldRun) return;
  runAccrualForEmployee(db, companyId, employeeRecordId, period);
}

export function recordLeaveDeduction(
  db: ServerDatabase,
  companyId: string,
  employeeRecordId: string,
  leaveType: string,
  days: number,
  leaveId: string,
  actorName: string
): void {
  const { period, date } = currentPeriod();
  const policy = getPolicyForType(db, companyId, leaveType);
  appendLedgerEntry(db, {
    companyId,
    employeeRecordId,
    leaveType,
    entryType: 'Deduction',
    days: -Math.abs(num(days)),
    policyId: policy?.policy_id ?? null,
    period,
    effectiveDate: date,
    referenceId: `LEAVE:${leaveId}`,
    description: `${actorName} approved ${days} ${leaveType} day(s) for leave ${leaveId}.`,
  });
}

function policySummary(policy: LeavePolicyRow | undefined): Record<string, unknown> {
  if (!policy) {
    return {
      policy_id: null,
      accrual_method: null,
      monthly_entitlement: null,
      annual_entitlement: null,
      credit_day: null,
      accrual_timing: null,
      eligibility: null,
      probation_months: null,
      prorate_by_joining_date: null,
      carry_forward: null,
      carry_forward_cap: null,
      expiry_months: null,
      max_balance: null,
      fractional_support: null,
      effective_from: null,
    };
  }
  return {
    policy_id: policy.policy_id,
    accrual_method: policy.accrual_method,
    monthly_entitlement: policy.monthly_entitlement,
    annual_entitlement: policy.annual_entitlement,
    credit_day: policy.credit_day,
    accrual_timing: policy.accrual_timing,
    eligibility: policy.eligibility,
    probation_months: policy.probation_months,
    prorate_by_joining_date: policy.prorate_by_joining_date,
    carry_forward: policy.carry_forward,
    carry_forward_cap: policy.carry_forward_cap,
    expiry_months: policy.expiry_months,
    max_balance: policy.max_balance,
    fractional_support: policy.fractional_support,
    effective_from: policy.effective_from,
  };
}

export function getLeaveOverview(
  db: ServerDatabase,
  companyId: string,
  employeeRecordId: string
): { balances: Record<string, unknown>[]; ledger: Record<string, unknown>[]; pending: Record<string, unknown>[]; policies: LeavePolicyRow[] } {
  const balanceRows = db
    .prepare(
      `SELECT balance_id, leave_type, total_days, used_days, current_balance, accrued_days,
              carry_forward_days, expired_days, year, updated_at
       FROM leave_balances
       WHERE company_id = ? AND employee_record_id = ?
       ORDER BY leave_type ASC, year DESC`
    )
    .all(companyId, employeeRecordId) as Array<Record<string, unknown>>;

  const pendingRows = db
    .prepare(
      `SELECT leave_type, COALESCE(SUM(days_count), 0) AS pending_days
       FROM leave_applications
       WHERE company_id = ? AND employee_record_id = ? AND status LIKE 'Pending%'
       GROUP BY leave_type`
    )
    .all(companyId, employeeRecordId) as Array<{ leave_type: string; pending_days: number }>;
  const pendingByType = new Map(pendingRows.map((row) => [row.leave_type, num(row.pending_days)]));

  const balances = balanceRows.map((row) => {
    const policy = getPolicyForType(db, companyId, String(row.leave_type));
    const current = num(row.current_balance);
    const pendingDays = pendingByType.get(String(row.leave_type)) ?? 0;
    return {
      ...row,
      current_balance: current,
      pending_days: round2(pendingDays),
      available_days: round2(Math.max(0, current - pendingDays)),
      ...policySummary(policy),
    };
  });

  const ledger = db
    .prepare(
      `SELECT * FROM leave_ledger
       WHERE company_id = ? AND employee_record_id = ?
       ORDER BY effective_date DESC, created_at DESC LIMIT 100`
    )
    .all(companyId, employeeRecordId) as Record<string, unknown>[];

  const pending = db
    .prepare(
      `SELECT leave_id, leave_type, start_date, end_date, days_count, day_mode, reason, status, created_at
       FROM leave_applications
       WHERE company_id = ? AND employee_record_id = ? AND status LIKE 'Pending%'
       ORDER BY created_at DESC`
    )
    .all(companyId, employeeRecordId) as Record<string, unknown>[];

  return { balances, ledger, pending, policies: getActivePolicies(db, companyId) };
}
