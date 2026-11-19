import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { PostgresDatabase, createPostgresSchema, dropPostgresSchema, type ServerDatabase } from './postgres.ts';
import { POSTGRES_SCHEMA_SQL } from './schema.ts';

let dbInstance: ServerDatabase | null = null;

function getConnectionString(): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required. Set it to your PostgreSQL connection string.');
  }
  return connectionString;
}

export function getDb(): ServerDatabase {
  if (dbInstance) return dbInstance;
  const db = new PostgresDatabase({ connectionString: getConnectionString() });
  initializeSchema(db);
  seedDatabaseIfEmpty(db);
  dbInstance = db;
  return db;
}

export async function createIsolatedDbForTests(): Promise<ServerDatabase> {
  const connectionString = getConnectionString();
  const schemaName = `test_${Date.now()}_${randomBytes(4).toString('hex')}`;
  await createPostgresSchema(connectionString, schemaName);
  try {
    const db = new PostgresDatabase({ connectionString, schemaName });
    initializeSchema(db);
    seedDatabaseIfEmpty(db);
    return db;
  } catch (err) {
    await dropPostgresSchema(connectionString, schemaName);
    throw err;
  }
}

export function initializeSchema(db: ServerDatabase): void {
  db.exec(POSTGRES_SCHEMA_SQL);
}

function seedDatabaseIfEmpty(db: ServerDatabase): void {
  const existing = db.prepare('SELECT COUNT(*) as count FROM roles').get() as { count: number };
  if (existing.count > 0) return;

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const yesterdayDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);

  db.exec('BEGIN IMMEDIATE;');
  try {
    const roles = [
      ['role_super_admin', 'Super Admin'],
      ['role_company_admin', 'Company Admin'],
      ['role_hr', 'HR'],
      ['role_hod', 'HOD'],
      ['role_manager', 'Manager'],
      ['role_resp', 'Responsible Person'],
      ['role_employee', 'Employee'],
    ];
    const insertRole = db.prepare('INSERT INTO roles (role_id, role_name) VALUES (?, ?)');
    for (const [id, name] of roles) insertRole.run(id, name);

    const passDefaultHash = bcrypt.hashSync('Password@123', 10);
    const passAdminHash = bcrypt.hashSync('Admin@123', 10);
    const passTempHash = bcrypt.hashSync('Temp@123', 10);

    // Sequences
    db.prepare('INSERT INTO id_sequences (seq_name, last_value) VALUES (?, ?)').run('company_seq', 3);
    db.prepare('INSERT INTO id_sequences (seq_name, last_value) VALUES (?, ?)').run('employee_seq', 10);

    // Companies
    const insertCompany = db.prepare(`
      INSERT INTO companies (company_id, company_name, company_email, contact_number, industry, address, website, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertCompany.run('CMP-001', 'ABC Technologies', 'hr@abctech.io', '+1 415-890-2410', 'Software & Cloud', '450 Mission St, San Francisco, CA', 'https://abctech.io', 'active', now);
    insertCompany.run('CMP-002', 'XYZ Solutions', 'people@xyzsolutions.com', '+1 212-555-0182', 'Enterprise Consulting', '350 Fifth Ave, New York, NY', 'https://xyzsolutions.com', 'active', now);
    insertCompany.run('CMP-003', 'Vertex Retail Corp', 'ops@vertexretail.com', '+1 312-555-0147', 'Retail Logistics', '233 S Wacker Dr, Chicago, IL', 'https://vertexretail.com', 'suspended', now);

    const insertSettings = db.prepare(`
      INSERT INTO company_settings (company_id, grace_period_minutes, half_day_hours, full_day_hours, workweek_days, require_geofence, support_email, support_phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertSettings.run('CMP-001', 15, 4.5, 8.0, 'Mon,Tue,Wed,Thu,Fri', 1, 'it-support@abctech.io', '+1 415-890-2499');
    insertSettings.run('CMP-002', 10, 4.0, 8.0, 'Mon,Tue,Wed,Thu,Fri', 1, 'helpdesk@xyzsolutions.com', '+1 212-555-0199');
    insertSettings.run('CMP-003', 15, 4.5, 8.0, 'Mon,Tue,Wed,Thu,Fri,Sat', 1, 'support@vertexretail.com', '+1 312-555-0199');

    // Departments
    const insertDept = db.prepare('INSERT INTO departments (department_id, company_id, name, code) VALUES (?, ?, ?, ?)');
    insertDept.run('dept_abc_eng', 'CMP-001', 'Engineering', 'ENG');
    insertDept.run('dept_abc_hr', 'CMP-001', 'Human Resources', 'HR');
    insertDept.run('dept_abc_ops', 'CMP-001', 'Operations', 'OPS');
    insertDept.run('dept_xyz_con', 'CMP-002', 'Advisory & Delivery', 'ADV');
    insertDept.run('dept_xyz_hr', 'CMP-002', 'People Operations', 'POP');
    insertDept.run('dept_vtx_ops', 'CMP-003', 'Store Operations', 'STR');

    // Office Locations
    const insertLoc = db.prepare(`
      INSERT INTO office_locations (location_id, company_id, name, address, latitude, longitude, radius_meters, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);
    insertLoc.run('loc_abc_sf', 'CMP-001', 'San Francisco HQ', '450 Mission St, San Francisco, CA', 37.7897, -122.3972, 300);
    insertLoc.run('loc_abc_blr', 'CMP-001', 'Bengaluru R&D Hub', 'Outer Ring Rd, Bellandur, Bengaluru', 12.9279, 77.6762, 250);
    insertLoc.run('loc_xyz_ny', 'CMP-002', 'Manhattan Tower', '350 Fifth Ave, New York, NY', 40.7484, -73.9857, 250);
    insertLoc.run('loc_vtx_chi', 'CMP-003', 'Chicago Central', '233 S Wacker Dr, Chicago, IL', 41.8789, -87.6359, 250);

    // Shifts
    const insertShift = db.prepare(`
      INSERT INTO shifts (shift_id, company_id, name, start_time, end_time, grace_minutes, break_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertShift.run('shift_abc_gen', 'CMP-001', 'General Day Shift', '09:00', '18:00', 15, 60);
    insertShift.run('shift_abc_early', 'CMP-001', 'Early Operations', '07:30', '16:30', 10, 45);
    insertShift.run('shift_xyz_gen', 'CMP-002', 'Standard Consulting', '09:30', '18:30', 10, 60);
    insertShift.run('shift_vtx_gen', 'CMP-003', 'Retail Core Shift', '08:30', '17:30', 15, 45);

    // Holidays
    const insertHoliday = db.prepare('INSERT INTO holidays (holiday_id, company_id, name, holiday_date, holiday_type) VALUES (?, ?, ?, ?, ?)');
    insertHoliday.run('hol_abc_1', 'CMP-001', 'Thanksgiving Day', '2026-11-26', 'Public');
    insertHoliday.run('hol_abc_2', 'CMP-001', 'Christmas Day', '2026-12-25', 'Public');
    insertHoliday.run('hol_abc_3', 'CMP-001', 'Annual Founders Day', '2026-12-11', 'Company');
    insertHoliday.run('hol_xyz_1', 'CMP-002', 'Thanksgiving Day', '2026-11-26', 'Public');
    insertHoliday.run('hol_xyz_2', 'CMP-002', 'Year-End Recharge', '2026-12-31', 'Company');

    const insertUser = db.prepare(`
      INSERT INTO users (user_id, username, password_hash, email, mobile, full_name, company_id, role_id, account_status, must_change_password, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertIdent = db.prepare('INSERT INTO login_identifiers (identifier, user_id, kind, created_at) VALUES (?, ?, ?, ?)');
    const insertEmp = db.prepare(`
      INSERT INTO employees (
        employee_record_id, employee_id, user_id, company_id, employee_name, email, mobile,
        department_id, designation, reporting_manager_id, hod_id, joining_date, employment_type,
        office_location_id, assigned_shift_id, employment_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Platform Super Admin (no company_id)
    insertUser.run('usr_super', 'superadmin', passAdminHash, 'platform@smartattend.io', '+1 800-555-0100', 'Platform Administrator', null, 'role_super_admin', 'active', 0, now);
    insertIdent.run('superadmin', 'usr_super', 'username', now);

    // ABC Technologies Users & Employees
    const abcEmployees = [
      {
        uid: 'usr_abc_admin', uname: 'admin_abc', hash: passDefaultHash, email: 'admin@abctech.io', mobile: '+1 415-890-2401',
        name: 'Elena Vance', role: 'role_company_admin', status: 'active', mustChange: 0,
        recId: 'rec_001', empId: 'EMP0001', dept: 'dept_abc_ops', desig: 'VP of Operations', mgr: null, hod: null, join: '2023-01-15', loc: 'loc_abc_sf', shift: 'shift_abc_gen', empStatus: 'active'
      },
      {
        uid: 'usr_abc_hr', uname: 'kavita_hr', hash: passDefaultHash, email: 'kavita@abctech.io', mobile: '+1 415-890-2402',
        name: 'Kavita Nair', role: 'role_hr', status: 'active', mustChange: 0,
        recId: 'rec_002', empId: 'EMP0002', dept: 'dept_abc_hr', desig: 'HR Business Partner', mgr: 'rec_001', hod: 'rec_001', join: '2023-03-01', loc: 'loc_abc_sf', shift: 'shift_abc_gen', empStatus: 'active'
      },
      {
        uid: 'usr_abc_hod', uname: 'arjun_hod', hash: passDefaultHash, email: 'arjun@abctech.io', mobile: '+1 415-890-2403',
        name: 'Arjun Mehta', role: 'role_hod', status: 'active', mustChange: 0,
        recId: 'rec_003', empId: 'EMP0003', dept: 'dept_abc_eng', desig: 'Head of Engineering', mgr: 'rec_001', hod: 'rec_003', join: '2023-04-10', loc: 'loc_abc_sf', shift: 'shift_abc_gen', empStatus: 'active'
      },
      {
        uid: 'usr_abc_rahul', uname: 'rahul', hash: passDefaultHash, email: 'rahul@abctech.io', mobile: '+1 415-890-2404',
        name: 'Rahul Sharma', role: 'role_employee', status: 'active', mustChange: 0,
        recId: 'rec_004', empId: 'EMP0004', dept: 'dept_abc_eng', desig: 'Senior Software Engineer', mgr: 'rec_003', hod: 'rec_003', join: '2024-02-05', loc: 'loc_abc_sf', shift: 'shift_abc_gen', empStatus: 'active'
      },
      {
        uid: 'usr_abc_neha', uname: 'neha_temp', hash: passTempHash, email: 'neha@abctech.io', mobile: '+1 415-890-2405',
        name: 'Neha Kulkarni', role: 'role_employee', status: 'active', mustChange: 1,
        recId: 'rec_005', empId: 'EMP0005', dept: 'dept_abc_eng', desig: 'Product Analyst', mgr: 'rec_003', hod: 'rec_003', join: '2026-11-10', loc: 'loc_abc_sf', shift: 'shift_abc_gen', empStatus: 'active'
      },
      {
        uid: 'usr_abc_rohit', uname: 'rohit_inactive', hash: passDefaultHash, email: 'rohit@abctech.io', mobile: '+1 415-890-2406',
        name: 'Rohit Verma', role: 'role_employee', status: 'inactive', mustChange: 0,
        recId: 'rec_006', empId: 'EMP0006', dept: 'dept_abc_ops', desig: 'Operations Associate', mgr: 'rec_001', hod: 'rec_001', join: '2024-06-15', loc: 'loc_abc_sf', shift: 'shift_abc_early', empStatus: 'inactive'
      }
    ];

    for (const e of abcEmployees) {
      insertUser.run(e.uid, e.uname, e.hash, e.email, e.mobile, e.name, 'CMP-001', e.role, e.status, e.mustChange, now);
      insertIdent.run(e.uname, e.uid, 'username', now);
      insertEmp.run(e.recId, e.empId, e.uid, 'CMP-001', e.name, e.email, e.mobile, e.dept, e.desig, e.mgr, e.hod, e.join, 'Full-Time', e.loc, e.shift, e.empStatus, now);
      insertIdent.run(e.empId, e.uid, 'employee_id', now);
    }

    // XYZ Solutions Users & Employees
    const xyzEmployees = [
      {
        uid: 'usr_xyz_admin', uname: 'admin_xyz', hash: passDefaultHash, email: 'admin@xyzsolutions.com', mobile: '+1 212-555-0111',
        name: 'Marcus Cole', role: 'role_company_admin', status: 'active', mustChange: 0,
        recId: 'rec_007', empId: 'EMP0007', dept: 'dept_xyz_hr', desig: 'Managing Director', mgr: null, hod: null, join: '2022-08-01', loc: 'loc_xyz_ny', shift: 'shift_xyz_gen', empStatus: 'active'
      },
      {
        uid: 'usr_xyz_mgr', uname: 'vikram_mgr', hash: passDefaultHash, email: 'vikram@xyzsolutions.com', mobile: '+1 212-555-0112',
        name: 'Vikram Iyer', role: 'role_manager', status: 'active', mustChange: 0,
        recId: 'rec_008', empId: 'EMP0008', dept: 'dept_xyz_con', desig: 'Delivery Manager', mgr: 'rec_007', hod: 'rec_007', join: '2023-05-12', loc: 'loc_xyz_ny', shift: 'shift_xyz_gen', empStatus: 'active'
      },
      {
        uid: 'usr_xyz_priya', uname: 'priya', hash: passDefaultHash, email: 'priya@xyzsolutions.com', mobile: '+1 212-555-0113',
        name: 'Priya Menon', role: 'role_employee', status: 'active', mustChange: 0,
        recId: 'rec_009', empId: 'EMP0009', dept: 'dept_xyz_con', desig: 'Principal Consultant', mgr: 'rec_008', hod: 'rec_007', join: '2024-09-01', loc: 'loc_xyz_ny', shift: 'shift_xyz_gen', empStatus: 'active'
      }
    ];

    for (const e of xyzEmployees) {
      insertUser.run(e.uid, e.uname, e.hash, e.email, e.mobile, e.name, 'CMP-002', e.role, e.status, e.mustChange, now);
      insertIdent.run(e.uname, e.uid, 'username', now);
      insertEmp.run(e.recId, e.empId, e.uid, 'CMP-002', e.name, e.email, e.mobile, e.dept, e.desig, e.mgr, e.hod, e.join, 'Full-Time', e.loc, e.shift, e.empStatus, now);
      insertIdent.run(e.empId, e.uid, 'employee_id', now);
    }

    // Vertex Retail Corp (Suspended company)
    insertUser.run('usr_vtx_admin', 'admin_vertex', passDefaultHash, 'admin@vertexretail.com', '+1 312-555-0190', 'Jordan Blake', 'CMP-003', 'role_company_admin', 'active', 0, now);
    insertIdent.run('admin_vertex', 'usr_vtx_admin', 'username', now);
    insertEmp.run('rec_010', 'EMP0010', 'usr_vtx_admin', 'CMP-003', 'Jordan Blake', 'admin@vertexretail.com', '+1 312-555-0190', 'dept_vtx_ops', 'Operations Director', null, null, '2024-01-10', 'Full-Time', 'loc_vtx_chi', 'shift_vtx_gen', 'active', now);
    insertIdent.run('EMP0010', 'usr_vtx_admin', 'employee_id', now);

    // Leave balances for 2026
    const insertBalance = db.prepare(`
      INSERT INTO leave_balances (balance_id, company_id, employee_record_id, leave_type, total_days, used_days, year)
      VALUES (?, ?, ?, ?, ?, ?, 2026)
    `);
    const allRecs: Array<[string, string]> = [
      ['rec_001', 'CMP-001'], ['rec_002', 'CMP-001'], ['rec_003', 'CMP-001'], ['rec_004', 'CMP-001'], ['rec_005', 'CMP-001'],
      ['rec_007', 'CMP-002'], ['rec_008', 'CMP-002'], ['rec_009', 'CMP-002'],
    ];
    for (const [recId, compId] of allRecs) {
      insertBalance.run(`bal_${recId}_ann`, compId, recId, 'Annual Leave', 18, recId === 'rec_004' ? 2 : 0);
      insertBalance.run(`bal_${recId}_sick`, compId, recId, 'Sick Leave', 10, recId === 'rec_009' ? 1 : 0);
      insertBalance.run(`bal_${recId}_cas`, compId, recId, 'Casual Leave', 6, 0);
    }

    // Seed Attendance Records
    const insertAtt = db.prepare(`
      INSERT INTO attendance_records (
        attendance_id, company_id, employee_record_id, attendance_date, shift_id,
        check_in_time, check_out_time, check_in_lat, check_in_lng, check_out_lat, check_out_lng,
        distance_meters, geofence_status, break_minutes, working_hours, is_late, late_minutes, is_half_day, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertAtt.run('att_1', 'CMP-001', 'rec_004', twoDaysAgo, 'shift_abc_gen', `${twoDaysAgo}T08:56:00.000Z`, `${twoDaysAgo}T18:10:00.000Z`, 37.7898, -122.3971, 37.7897, -122.3972, 14, 'Within Geofence', 45, 8.48, 0, 0, 0, 'Present', 'On time check-in');
    insertAtt.run('att_2', 'CMP-001', 'rec_004', yesterdayDate, 'shift_abc_gen', `${yesterdayDate}T09:24:00.000Z`, `${yesterdayDate}T18:05:00.000Z`, 37.7899, -122.3970, 37.7897, -122.3972, 28, 'Within Geofence', 60, 7.68, 1, 24, 0, 'Late', '24 mins past shift start');
    insertAtt.run('att_3', 'CMP-001', 'rec_003', yesterdayDate, 'shift_abc_gen', `${yesterdayDate}T08:50:00.000Z`, `${yesterdayDate}T18:15:00.000Z`, 37.7897, -122.3972, 37.7897, -122.3972, 5, 'Within Geofence', 45, 8.67, 0, 0, 0, 'Present', null);
    insertAtt.run('att_4', 'CMP-001', 'rec_002', today, 'shift_abc_gen', `${today}T08:58:00.000Z`, null, 37.7896, -122.3973, null, null, 18, 'Within Geofence', 0, 0, 0, 0, 0, 'Checked In', null);

    // XYZ Attendance Records (isolated!)
    insertAtt.run('att_5', 'CMP-002', 'rec_009', yesterdayDate, 'shift_xyz_gen', `${yesterdayDate}T09:25:00.000Z`, `${yesterdayDate}T18:30:00.000Z`, 40.7484, -73.9857, 40.7484, -73.9857, 8, 'Within Geofence', 60, 8.08, 0, 0, 0, 'Present', null);
    insertAtt.run('att_6', 'CMP-002', 'rec_008', today, 'shift_xyz_gen', `${today}T09:22:00.000Z`, null, 40.7485, -73.9856, null, null, 14, 'Within Geofence', 0, 0, 0, 0, 0, 'Checked In', null);

    // Seed Leave Applications
    const insertLeave = db.prepare(`
      INSERT INTO leave_applications (
        leave_id, company_id, employee_record_id, leave_type, start_date, end_date, days_count,
        day_mode, is_paid, reason, status, l1_approver_id, l1_status, l2_approver_id, l2_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertLeave.run('lv_abc_1', 'CMP-001', 'rec_004', 'Annual Leave', '2026-12-03', '2026-12-04', 2, 'Full Day', 1, 'Family wedding travel', 'Pending L1', 'rec_003', 'Pending', 'rec_002', 'Pending', now);
    insertLeave.run('lv_xyz_1', 'CMP-002', 'rec_009', 'Casual Leave', '2026-11-27', '2026-11-27', 0.5, 'Half Day', 1, 'Personal bank appointment', 'Pending L1', 'rec_008', 'Pending', 'rec_007', 'Pending', now);

    // Seed Regularization & WFH
    db.prepare(`
      INSERT INTO regularization_requests (reg_id, company_id, employee_record_id, attendance_date, requested_check_in, requested_check_out, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('reg_abc_1', 'CMP-001', 'rec_004', yesterdayDate, '09:00', '18:05', 'Transit delay at BART station; logged onto mobile hotspot at 09:00', 'Pending', now);

    db.prepare(`
      INSERT INTO wfh_requests (wfh_id, company_id, employee_record_id, wfh_date, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('wfh_abc_1', 'CMP-001', 'rec_004', '2026-11-24', 'Sprint release preparation from home office', 'Pending', now);

    // Notifications
    const insertNotif = db.prepare(`
      INSERT INTO notifications (notification_id, company_id, user_id, title, message, category, is_read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `);
    insertNotif.run('ntf_1', 'CMP-001', 'usr_abc_hod', 'Leave Approval Needed', 'Rahul Sharma (EMP0004) requested 2 days Annual Leave starting 2026-12-03.', 'Leave', now);
    insertNotif.run('ntf_2', 'CMP-001', 'usr_abc_rahul', 'Regularization Submitted', 'Your attendance regularization request is awaiting manager review.', 'Attendance', now);
    insertNotif.run('ntf_3', 'CMP-002', 'usr_xyz_mgr', 'Half-Day Leave Request', 'Priya Menon (EMP0009) requested a half-day Casual Leave on 2026-11-27.', 'Leave', now);

    // Initial Audit Log
    db.prepare(`
      INSERT INTO audit_logs (log_id, company_id, actor_user_id, actor_username, action, target_type, target_id, outcome, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('aud_seed_1', null, 'usr_super', 'superadmin', 'SYSTEM_INITIALIZED', 'platform', 'smartattend', 'success', 'Multi-tenant authentication and global identifier registry initialized.', now);

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}
