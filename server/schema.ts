export const POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS companies (
  company_id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  company_email TEXT NOT NULL,
  contact_number TEXT NOT NULL,
  industry TEXT NOT NULL,
  address TEXT NOT NULL,
  website TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_company_email_ci_uq ON companies (LOWER(company_email));

CREATE TABLE IF NOT EXISTS company_settings (
  company_id TEXT PRIMARY KEY REFERENCES companies(company_id) ON DELETE CASCADE,
  grace_period_minutes INTEGER NOT NULL DEFAULT 15,
  half_day_hours DOUBLE PRECISION NOT NULL DEFAULT 4.5,
  full_day_hours DOUBLE PRECISION NOT NULL DEFAULT 8.0,
  workweek_days TEXT NOT NULL DEFAULT 'Mon,Tue,Wed,Thu,Fri',
  require_geofence INTEGER NOT NULL DEFAULT 1,
  support_email TEXT NOT NULL DEFAULT 'support@smartattend.io',
  support_phone TEXT NOT NULL DEFAULT '+1 (800) 555-0194'
);

CREATE TABLE IF NOT EXISTS roles (
  role_id TEXT PRIMARY KEY,
  role_name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  mobile TEXT NOT NULL,
  full_name TEXT NOT NULL,
  company_id TEXT REFERENCES companies(company_id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'inactive')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci_uq ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS departments (
  department_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS departments_company_name_ci_uq ON departments (company_id, LOWER(name));

CREATE TABLE IF NOT EXISTS office_locations (
  location_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  radius_meters INTEGER NOT NULL DEFAULT 250,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS shifts (
  shift_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  grace_minutes INTEGER NOT NULL DEFAULT 15,
  break_minutes INTEGER NOT NULL DEFAULT 60,
  working_hours DOUBLE PRECISION NOT NULL DEFAULT 8
);

CREATE TABLE IF NOT EXISTS employees (
  employee_record_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  employee_name TEXT NOT NULL,
  email TEXT NOT NULL,
  mobile TEXT NOT NULL,
  department_id TEXT REFERENCES departments(department_id),
  designation TEXT NOT NULL,
  reporting_manager_id TEXT,
  hod_id TEXT,
  joining_date TEXT NOT NULL,
  employment_type TEXT NOT NULL DEFAULT 'Full-Time',
  office_location_id TEXT REFERENCES office_locations(location_id),
  assigned_shift_id TEXT REFERENCES shifts(shift_id),
  employment_status TEXT NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active', 'on_leave', 'inactive', 'terminated')),
  profile_picture TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_employee_id_ci_uq ON employees (LOWER(employee_id));

CREATE TABLE IF NOT EXISTS login_identifiers (
  identifier TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('username', 'employee_id')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS login_identifiers_identifier_ci_uq ON login_identifiers (LOWER(identifier));

CREATE TABLE IF NOT EXISTS id_sequences (
  seq_name TEXT PRIMARY KEY,
  last_value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  company_id TEXT,
  expires_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sandbox_outbox (
  id TEXT PRIMARY KEY,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  reset_code TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_rate_limits (
  rate_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TEXT NOT NULL,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  log_id TEXT PRIMARY KEY,
  company_id TEXT,
  actor_user_id TEXT,
  actor_username TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  outcome TEXT NOT NULL,
  details TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS holidays (
  holiday_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  holiday_date TEXT NOT NULL,
  holiday_type TEXT NOT NULL DEFAULT 'Public'
);

CREATE TABLE IF NOT EXISTS attendance_records (
  attendance_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  employee_record_id TEXT NOT NULL REFERENCES employees(employee_record_id) ON DELETE CASCADE,
  attendance_date TEXT NOT NULL,
  shift_id TEXT,
  check_in_time TEXT,
  check_out_time TEXT,
  check_in_lat DOUBLE PRECISION,
  check_in_lng DOUBLE PRECISION,
  check_out_lat DOUBLE PRECISION,
  check_out_lng DOUBLE PRECISION,
  distance_meters DOUBLE PRECISION,
  geofence_status TEXT,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  active_break_start TEXT,
  working_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  is_late INTEGER NOT NULL DEFAULT 0,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  is_half_day INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Present',
  notes TEXT,
  UNIQUE (employee_record_id, attendance_date)
);

CREATE TABLE IF NOT EXISTS gps_logs (
  gps_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  employee_record_id TEXT NOT NULL REFERENCES employees(employee_record_id) ON DELETE CASCADE,
  attendance_id TEXT,
  event_type TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  distance_meters DOUBLE PRECISION NOT NULL,
  within_geofence INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leave_balances (
  balance_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  employee_record_id TEXT NOT NULL REFERENCES employees(employee_record_id) ON DELETE CASCADE,
  leave_type TEXT NOT NULL,
  total_days DOUBLE PRECISION NOT NULL,
  used_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  year INTEGER NOT NULL,
  UNIQUE (employee_record_id, leave_type, year)
);

CREATE TABLE IF NOT EXISTS leave_applications (
  leave_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  employee_record_id TEXT NOT NULL REFERENCES employees(employee_record_id) ON DELETE CASCADE,
  leave_type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days_count DOUBLE PRECISION NOT NULL,
  day_mode TEXT NOT NULL DEFAULT 'Full Day',
  is_paid INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending L1',
  l1_approver_id TEXT,
  l1_status TEXT DEFAULT 'Pending',
  l1_comment TEXT,
  l2_approver_id TEXT,
  l2_status TEXT DEFAULT 'Pending',
  l2_comment TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regularization_requests (
  reg_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  employee_record_id TEXT NOT NULL REFERENCES employees(employee_record_id) ON DELETE CASCADE,
  attendance_date TEXT NOT NULL,
  requested_check_in TEXT NOT NULL,
  requested_check_out TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',
  reviewed_by TEXT,
  review_comment TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wfh_requests (
  wfh_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  employee_record_id TEXT NOT NULL REFERENCES employees(employee_record_id) ON DELETE CASCADE,
  wfh_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',
  reviewed_by TEXT,
  review_comment TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  category TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

ALTER TABLE employees ADD COLUMN IF NOT EXISTS address TEXT;

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS working_hours DOUBLE PRECISION NOT NULL DEFAULT 8;

ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS effective_shift_date TEXT;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS expected_working_hours DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS shift_start_time TEXT;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS shift_end_time TEXT;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS break_policy_type TEXT;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS break_compliance TEXT;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS break_completed_minutes INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS shift_assignments (
  assignment_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('company', 'department', 'employee')),
  scope_id TEXT,
  shift_id TEXT NOT NULL REFERENCES shifts(shift_id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS shift_assignments_scope_idx
  ON shift_assignments (company_id, scope_type, scope_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS lunch_break_configs (
  config_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('company', 'department', 'employee')),
  scope_id TEXT,
  break_type TEXT NOT NULL CHECK (break_type IN ('mandatory', 'optional', 'flexible')),
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  window_start TEXT,
  window_end TEXT,
  max_duration_minutes INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lunch_break_configs_scope_idx
  ON lunch_break_configs (company_id, scope_type, scope_id, is_active);

CREATE TABLE IF NOT EXISTS attendance_breaks (
  break_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  attendance_id TEXT NOT NULL REFERENCES attendance_records(attendance_id) ON DELETE CASCADE,
  employee_record_id TEXT NOT NULL REFERENCES employees(employee_record_id) ON DELETE CASCADE,
  break_type TEXT NOT NULL CHECK (break_type IN ('mandatory', 'optional', 'flexible', 'unconfigured')),
  break_start TEXT NOT NULL,
  break_end TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  compliance TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attendance_breaks_attendance_idx
  ON attendance_breaks (company_id, attendance_id, break_start);
`;

export const MIGRATION_TABLE_ORDER = [
  'companies',
  'company_settings',
  'roles',
  'users',
  'departments',
  'office_locations',
  'shifts',
  'employees',
  'login_identifiers',
  'id_sequences',
  'sessions',
  'password_reset_tokens',
  'sandbox_outbox',
  'login_rate_limits',
  'audit_logs',
  'holidays',
  'attendance_records',
  'gps_logs',
  'leave_balances',
  'leave_applications',
  'regularization_requests',
  'wfh_requests',
  'notifications',
  'shift_assignments',
  'lunch_break_configs',
  'attendance_breaks',
] as const;
