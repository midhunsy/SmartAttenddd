export type UserRole =
  | 'Super Admin'
  | 'Company Admin'
  | 'HR'
  | 'HOD'
  | 'Manager'
  | 'Responsible Person'
  | 'Employee';

export interface AuthUser {
  userId: string;
  username: string;
  fullName: string;
  email: string;
  role: UserRole;
  companyId: string | null;
  companyName: string | null;
  companyStatus?: string | null;
  employeeRecordId: string | null;
  employeeId: string | null;
  mustChangePassword: boolean;
}

export interface EmployeeRow {
  employee_record_id: string;
  employee_id: string;
  user_id: string;
  company_id: string;
  employee_name: string;
  email: string;
  mobile: string;
  department_id: string | null;
  department_name: string | null;
  designation: string;
  reporting_manager_id: string | null;
  reporting_manager_name: string | null;
  hod_id: string | null;
  hod_name: string | null;
  joining_date: string;
  employment_type: string;
  office_location_id: string | null;
  location_name: string | null;
  assigned_shift_id: string | null;
  shift_name: string | null;
  employment_status: string;
  profile_picture: string | null;
  username: string;
  account_status: string;
  must_change_password: number;
  role_name: UserRole;
  created_at: string;
}

export interface Department {
  department_id: string;
  company_id: string;
  name: string;
  code: string;
}

export interface OfficeLocation {
  location_id: string;
  company_id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  is_active: number;
}

export interface Shift {
  shift_id: string;
  company_id: string;
  name: string;
  start_time: string;
  end_time: string;
  grace_minutes: number;
  break_minutes: number;
}

export interface Holiday {
  holiday_id: string;
  company_id: string;
  name: string;
  holiday_date: string;
  holiday_type: string;
}

export interface CompanySettings {
  company_id: string;
  grace_period_minutes: number;
  half_day_hours: number;
  full_day_hours: number;
  workweek_days: string;
  require_geofence: number;
  support_email: string;
  support_phone: string;
}

export interface AttendanceRecord {
  attendance_id: string;
  company_id: string;
  employee_record_id: string;
  employee_name?: string;
  employee_id?: string;
  department_name?: string;
  shift_name?: string;
  attendance_date: string;
  check_in_time: string | null;
  check_out_time: string | null;
  distance_meters: number | null;
  geofence_status: string | null;
  break_minutes: number;
  active_break_start: string | null;
  working_hours: number;
  is_late: number;
  late_minutes: number;
  is_half_day: number;
  status: string;
  notes: string | null;
}

export interface LeaveBalance {
  balance_id: string;
  leave_type: string;
  total_days: number;
  used_days: number;
  year: number;
}

export interface LeaveApplication {
  leave_id: string;
  employee_record_id: string;
  employee_name: string;
  employee_id: string;
  department_name: string | null;
  leave_type: string;
  start_date: string;
  end_date: string;
  days_count: number;
  day_mode: string;
  is_paid: number;
  reason: string;
  status: string;
  l1_status: string;
  l2_status: string;
  created_at: string;
}

export interface RegularizationRequest {
  reg_id: string;
  employee_record_id: string;
  employee_name: string;
  employee_id: string;
  attendance_date: string;
  requested_check_in: string;
  requested_check_out: string;
  reason: string;
  status: string;
  reviewed_by: string | null;
  created_at: string;
}

export interface WfhRequest {
  wfh_id: string;
  employee_record_id: string;
  employee_name: string;
  employee_id: string;
  wfh_date: string;
  reason: string;
  status: string;
  reviewed_by: string | null;
  created_at: string;
}

export interface PayrollRow {
  employee_record_id: string;
  employee_id: string;
  employee_name: string;
  designation: string;
  department_name: string | null;
  present_days: number;
  late_days: number;
  half_days: number;
  wfh_days: number;
  total_hours: number;
  paid_leave_days: number;
  unpaid_leave_days: number;
}

export interface NotificationItem {
  notification_id: string;
  title: string;
  message: string;
  category: string;
  is_read: number;
  created_at: string;
}

export interface AuditLogItem {
  log_id: string;
  company_id: string | null;
  actor_username: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: string;
  details: string | null;
  created_at: string;
}

export interface CompanySummary {
  company_id: string;
  company_name: string;
  company_email: string;
  contact_number: string;
  industry: string;
  address: string;
  website: string | null;
  status: 'active' | 'suspended';
  employee_count: number;
  active_users: number;
  created_at: string;
}
