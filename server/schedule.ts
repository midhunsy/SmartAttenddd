import type { ServerDatabase } from './postgres.ts';

export type ShiftRow = {
  shift_id: string;
  company_id: string;
  name: string;
  start_time: string;
  end_time: string;
  grace_minutes: number;
  break_minutes: number;
  working_hours: number;
};

export type ShiftAssignmentRow = {
  assignment_id: string;
  company_id: string;
  scope_type: 'company' | 'department' | 'employee';
  scope_id: string | null;
  shift_id: string;
  start_date: string;
  end_date: string;
  name?: string;
  start_time?: string;
  end_time?: string;
  grace_minutes?: number;
  break_minutes?: number;
  working_hours?: number;
};

export type BreakConfigRow = {
  config_id: string;
  company_id: string;
  scope_type: 'company' | 'department' | 'employee';
  scope_id: string | null;
  break_type: 'mandatory' | 'optional' | 'flexible';
  duration_minutes: number;
  window_start: string | null;
  window_end: string | null;
  max_duration_minutes: number | null;
  is_active: number;
};

export type ResolvedShift = {
  shift: ShiftRow | null;
  assignment: ShiftAssignmentRow | null;
  source: 'company' | 'department' | 'employee' | 'employee_profile' | 'company_default' | 'none';
};

export type ResolvedAttendanceShift = ResolvedShift & {
  attendanceDate: string;
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTime(value: unknown): boolean {
  return typeof value === 'string' && TIME_PATTERN.test(value);
}

export function isValidDate(value: unknown): boolean {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseTimeToMinutes(value: string | null | undefined, fallback = 0): number {
  if (!value || !TIME_PATTERN.test(value)) return fallback;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear().toString().padStart(4, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function isOvernightShift(shift: Pick<ShiftRow, 'start_time' | 'end_time'>): boolean {
  return parseTimeToMinutes(shift.end_time) <= parseTimeToMinutes(shift.start_time);
}

export function rangesOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
  return startA <= endB && startB <= endA;
}

function localClockMinutes(iso: string): number {
  const date = new Date(iso);
  return date.getHours() * 60 + date.getMinutes();
}

function isWithinWindow(iso: string, windowStart: string | null, windowEnd: string | null): boolean {
  if (!windowStart || !windowEnd) return true;
  const now = localClockMinutes(iso);
  const start = parseTimeToMinutes(windowStart);
  const end = parseTimeToMinutes(windowEnd);
  if (end < start) return now >= start || now <= end;
  return now >= start && now <= end;
}

export function evaluateBreakCompliance(
  config: BreakConfigRow | null,
  durationMinutes: number,
  breakStart: string,
  breakEnd: string
): string {
  if (!config) return 'unconfigured';

  const minOk = durationMinutes >= config.duration_minutes;
  const maxOk = config.max_duration_minutes === null || durationMinutes <= config.max_duration_minutes;
  const withinWindow = isWithinWindow(breakStart, config.window_start, config.window_end)
    && isWithinWindow(breakEnd, config.window_start, config.window_end);
  const insideRules = minOk && maxOk && withinWindow;

  if (config.break_type === 'mandatory') return insideRules ? 'completed' : 'incomplete';
  return insideRules ? 'completed' : 'outside_rules';
}

export function evaluateOverallBreakCompliance(
  config: BreakConfigRow | null,
  completedMinutes: number,
  lastEventCompliance: string | null
): string {
  if (!config) return 'unconfigured';
  if (config.break_type === 'optional') {
    if (completedMinutes === 0) return 'not_applicable';
    return lastEventCompliance === 'outside_rules' ? 'outside_rules' : 'completed';
  }
  if (completedMinutes >= config.duration_minutes) return 'completed';
  if (lastEventCompliance === 'outside_rules') return 'outside_rules';
  if (config.break_type === 'flexible') return completedMinutes > 0 ? 'outside_rules' : 'not_taken';
  return lastEventCompliance === 'pending' ? 'pending' : 'incomplete';
}

export function resolveShiftAssignment(
  db: ServerDatabase,
  companyId: string,
  employeeRecordId: string,
  date: string
): ResolvedShift {
  const employee = db
    .prepare('SELECT department_id, assigned_shift_id FROM employees WHERE employee_record_id = ? AND company_id = ?')
    .get(employeeRecordId, companyId) as { department_id: string | null; assigned_shift_id: string | null } | undefined;

  if (!employee) {
    return { shift: null, assignment: null, source: 'none' };
  }

  const assignment = db
    .prepare(`
      SELECT sa.*, s.name, s.start_time, s.end_time, s.grace_minutes, s.break_minutes, s.working_hours
      FROM shift_assignments sa
      JOIN shifts s ON s.shift_id = sa.shift_id AND s.company_id = sa.company_id
      WHERE sa.company_id = ? AND sa.start_date <= ? AND sa.end_date >= ?
        AND (
          sa.scope_type = 'company'
          OR (sa.scope_type = 'department' AND sa.scope_id = ?)
          OR (sa.scope_type = 'employee' AND sa.scope_id = ?)
        )
      ORDER BY
        CASE sa.scope_type WHEN 'employee' THEN 3 WHEN 'department' THEN 2 ELSE 1 END DESC,
        sa.start_date DESC,
        sa.assignment_id DESC
      LIMIT 1
    `)
    .get(companyId, date, date, employee.department_id ?? '', employeeRecordId) as ShiftAssignmentRow | undefined;

  if (assignment) {
    const shift: ShiftRow = {
      shift_id: assignment.shift_id,
      company_id: assignment.company_id,
      name: assignment.name ?? '',
      start_time: assignment.start_time ?? '09:00',
      end_time: assignment.end_time ?? '18:00',
      grace_minutes: assignment.grace_minutes ?? 15,
      break_minutes: assignment.break_minutes ?? 60,
      working_hours: assignment.working_hours ?? 8,
    };
    return {
      shift,
      assignment,
      source: assignment.scope_type,
    };
  }

  if (employee.assigned_shift_id) {
    const shift = db
      .prepare('SELECT * FROM shifts WHERE shift_id = ? AND company_id = ?')
      .get(employee.assigned_shift_id, companyId) as ShiftRow | undefined;
    if (shift) {
      return { shift, assignment: null, source: 'employee_profile' };
    }
  }

  const fallbackShift = db
    .prepare('SELECT * FROM shifts WHERE company_id = ? ORDER BY name LIMIT 1')
    .get(companyId) as ShiftRow | undefined;
  return {
    shift: fallbackShift ?? null,
    assignment: null,
    source: fallbackShift ? 'company_default' : 'none',
  };
}

export function resolveAttendanceDateForShift(
  shift: Pick<ShiftRow, 'start_time' | 'end_time'>,
  now: Date,
  localDate = formatLocalDate(now)
): string {
  const previousDate = addDays(localDate, -1);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const endMinutes = parseTimeToMinutes(shift.end_time, 0);
  return isOvernightShift(shift) && nowMinutes <= endMinutes ? previousDate : localDate;
}

export function resolveAttendanceShift(
  db: ServerDatabase,
  companyId: string,
  employeeRecordId: string,
  now: Date
): ResolvedAttendanceShift {
  const localDate = formatLocalDate(now);
  const previousDate = addDays(localDate, -1);
  const previous = resolveShiftAssignment(db, companyId, employeeRecordId, previousDate);
  const attendanceDate = previous.shift
    ? resolveAttendanceDateForShift(previous.shift, now, localDate)
    : localDate;

  if (attendanceDate === previousDate) {
    return { ...previous, attendanceDate };
  }

  return { ...resolveShiftAssignment(db, companyId, employeeRecordId, localDate), attendanceDate: localDate };
}

export function resolveBreakConfig(
  db: ServerDatabase,
  companyId: string,
  employeeRecordId: string,
  date: string
): BreakConfigRow | null {
  const employee = db
    .prepare('SELECT department_id FROM employees WHERE employee_record_id = ? AND company_id = ?')
    .get(employeeRecordId, companyId) as { department_id: string | null } | undefined;
  if (!employee) return null;

  return (db
    .prepare(`
      SELECT *
      FROM lunch_break_configs
      WHERE company_id = ? AND is_active = 1
        AND (
          scope_type = 'company'
          OR (scope_type = 'department' AND scope_id = ?)
          OR (scope_type = 'employee' AND scope_id = ?)
        )
      ORDER BY
        CASE scope_type WHEN 'employee' THEN 3 WHEN 'department' THEN 2 ELSE 1 END DESC,
        updated_at DESC,
        config_id DESC
      LIMIT 1
    `)
    .get(companyId, employee.department_id ?? '', employeeRecordId) as BreakConfigRow | undefined) ?? null;
}
