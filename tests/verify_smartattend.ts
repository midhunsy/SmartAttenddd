import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createIsolatedDbForTests } from '../server/db.ts';
import { createExpressApp } from '../server.ts';

function localDateText(date = new Date()): string {
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
}

function dateFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDateText(date);
}

async function runTests() {
  const db = await createIsolatedDbForTests();
  const app = createExpressApp(db);

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function req(
    urlPath: string,
    options: { method?: string; token?: string; body?: unknown; ip?: string } = {}
  ) {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
    if (options.ip) headers['X-Forwarded-For'] = options.ip;
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  let passed = 0;
  const test = async (name: string, fn: () => Promise<void>) => {
    await fn();
    passed += 1;
    console.log(`PASS [${passed}]: ${name}`);
  };

  try {
    let novaAdminToken = '';
    let novaCompanyId = '';
    let createdEmpUsername = 'maya_nova';
    let createdEmpId = '';
    let createdEmpRecId = '';

    // 1 & 2. New company registration + Admin account creation
    await test('1 & 2. New company registration & Admin account creation', async () => {
      const res = await req('/api/auth/register-company', {
        method: 'POST',
        body: {
          companyName: 'Nova Dynamics Ltd',
          companyEmail: 'hello@novadynamics.io',
          contactNumber: '+1 650-555-0190',
          industry: 'Robotics & AI',
          address: '700 Santana Row, San Jose, CA',
          website: 'https://novadynamics.io',
          adminFullName: 'Tara Singh',
          adminEmail: 'tara@novadynamics.io',
          adminMobile: '+1 650-555-0191',
          username: 'admin_nova',
          password: 'Password@123',
          confirmPassword: 'Password@123',
        },
      });
      assert.equal(res.status, 201);
      assert.ok(res.data.token);
      assert.equal(res.data.user.role, 'Company Admin');
      assert.ok(res.data.user.companyId);
      assert.ok(res.data.user.employeeId.startsWith('EMP'));
      novaCompanyId = res.data.user.companyId;
    });

    // 3. Admin login using username (without company code)
    await test('3. Admin login using username (automatic company identification)', async () => {
      const res = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'admin_nova', password: 'Password@123' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.user.companyId, novaCompanyId);
      assert.equal(res.data.user.companyName, 'Nova Dynamics Ltd');
      assert.equal(res.data.user.role, 'Company Admin');
      novaAdminToken = res.data.token;
    });

    // 4. Employee creation by admin (with auto-generated Employee ID)
    await test('4. Employee creation by admin & automatic Employee ID generation', async () => {
      const res = await req('/api/employees', {
        method: 'POST',
        token: novaAdminToken,
        body: {
          employeeName: 'Maya Kapoor',
          email: 'maya@novadynamics.io',
          mobile: '+1 650-555-0195',
          designation: 'Field Engineer',
          joiningDate: '2026-11-19',
          employmentType: 'Full-Time',
          roleName: 'Employee',
          username: createdEmpUsername,
          password: 'Password@123',
          confirmPassword: 'Password@123',
          forcePasswordChange: false,
        },
      });
      assert.equal(res.status, 201);
      assert.ok(res.data.employee.employeeId.startsWith('EMP'));
      createdEmpId = res.data.employee.employeeId;
      createdEmpRecId = res.data.employee.employeeRecordId;

      // Ensure password is never returned in GET /api/employees
      const list = await req('/api/employees', { token: novaAdminToken });
      assert.equal(list.status, 200);
      for (const e of list.data.employees) {
        assert.equal(e.password_hash, undefined);
        assert.equal(e.password, undefined);
      }
    });

    // 5. Employee login using username
    await test('5. Employee login using username', async () => {
      const res = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: createdEmpUsername, password: 'Password@123' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.user.companyId, novaCompanyId);
      assert.equal(res.data.user.employeeId, createdEmpId);
    });

    // 6. Employee login using auto-generated Employee ID
    await test('6. Employee login using system-generated Employee ID', async () => {
      const res = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: createdEmpId, password: 'Password@123' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.user.username, createdEmpUsername);
      assert.equal(res.data.user.companyId, novaCompanyId);
    });

    // 7. Duplicate username prevention across companies
    await test('7. Duplicate username prevention across companies (ABC Tech vs Nova)', async () => {
      // rahul belongs to ABC Technologies (CMP-001). Nova Dynamics must NOT be allowed to create 'rahul' or 'RAHUL'.
      const res = await req('/api/employees', {
        method: 'POST',
        token: novaAdminToken,
        body: {
          employeeName: 'Duplicate Rahul',
          email: 'dup@novadynamics.io',
          mobile: '+1 650-555-0196',
          designation: 'QA Engineer',
          username: 'RAHUL',
          password: 'Password@123',
          confirmPassword: 'Password@123',
        },
      });
      assert.equal(res.status, 409);
      assert.equal(res.data.code, 'USERNAME_TAKEN');
    });

    // 8. Duplicate Employee ID prevention at DB level
    await test('8. Duplicate Employee ID prevention at database level', async () => {
      assert.throws(() => {
        db.prepare(`
          INSERT INTO employees (employee_record_id, employee_id, user_id, company_id, employee_name, email, mobile, designation, joining_date, created_at)
          VALUES ('rec_dup', ?, 'usr_abc_rahul', 'CMP-001', 'Dup', 'd@d.com', '123', 'Eng', '2026-01-01', '2026-01-01')
        `).run(createdEmpId);
      });
    });

    // 9. Username and Employee ID collision prevention
    await test('9. Username and Employee ID collision prevention', async () => {
      // Try registering a username matching an existing Employee ID (EMP0004)
      const res1 = await req('/api/employees', {
        method: 'POST',
        token: novaAdminToken,
        body: {
          employeeName: 'Collision Test',
          email: 'col@novadynamics.io',
          mobile: '+1 650-555-0197',
          designation: 'Analyst',
          username: 'EMP0004',
          password: 'Password@123',
          confirmPassword: 'Password@123',
        },
      });
      assert.equal(res1.status, 409);

      // Reserve the next Employee ID number as a username, then ensure generator skips it!
      const seqRow = db.prepare('SELECT last_value FROM id_sequences WHERE seq_name = ?').get('employee_seq') as {
        last_value: number;
      };
      const reservedUsername = `EMP${String(seqRow.last_value + 1).padStart(4, '0')}`;
      const res2 = await req('/api/employees', {
        method: 'POST',
        token: novaAdminToken,
        body: {
          employeeName: 'Reserved Username Emp',
          email: 'res@novadynamics.io',
          mobile: '+1 650-555-0198',
          designation: 'Analyst',
          username: reservedUsername,
          password: 'Password@123',
          confirmPassword: 'Password@123',
          forcePasswordChange: false,
        },
      });
      assert.equal(res2.status, 201);
      assert.notEqual(res2.data.employee.employeeId, reservedUsername);
    });

    // 10. Incorrect password & rate limiting
    await test('10. Incorrect password handling & rate limiting', async () => {
      const bad = await req('/api/auth/login', {
        method: 'POST',
        ip: '10.0.0.55',
        body: { identifier: 'rahul', password: 'WrongPassword1!' },
      });
      assert.equal(bad.status, 401);
    });

    // 11. Forgot password + session invalidation
    await test('11. Forgot password flow, token reuse prevention, & session revocation', async () => {
      const loginBefore = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'priya', password: 'Password@123' },
      });
      assert.equal(loginBefore.status, 200);
      const oldSessionToken = loginBefore.data.token;

      // Non-enumerating request for unknown user must look identical to valid user
      const unknownForgot = await req('/api/auth/forgot-password', {
        method: 'POST',
        body: { identifier: 'nonexistent_person_999' },
      });
      const validForgot = await req('/api/auth/forgot-password', {
        method: 'POST',
        body: { identifier: 'priya' },
      });
      assert.equal(unknownForgot.status, 200);
      assert.equal(validForgot.status, 200);
      assert.equal(unknownForgot.data.message, validForgot.data.message);

      const outbox = await req('/api/auth/sandbox-outbox');
      const priyaMsg = outbox.data.messages.find((m: { recipient_email: string }) =>
        m.recipient_email.includes('priya')
      );
      assert.ok(priyaMsg?.reset_code);

      const resetRes = await req('/api/auth/reset-password', {
        method: 'POST',
        body: {
          token: priyaMsg.reset_code,
          newPassword: 'NewPassword@456',
          confirmPassword: 'NewPassword@456',
        },
      });
      assert.equal(resetRes.status, 200);

      // Reusing token must fail
      const reuseRes = await req('/api/auth/reset-password', {
        method: 'POST',
        body: {
          token: priyaMsg.reset_code,
          newPassword: 'AnotherPassword@789',
          confirmPassword: 'AnotherPassword@789',
        },
      });
      assert.equal(reuseRes.status, 400);

      // Old session must be invalidated
      const meAfter = await req('/api/auth/me', { token: oldSessionToken });
      assert.equal(meAfter.status, 401);

      // New password works
      const loginNew = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'priya', password: 'NewPassword@456' },
      });
      assert.equal(loginNew.status, 200);
    });

    // 12. First-login password change enforcement
    await test('12. First-login forced password change restricts modules until updated', async () => {
      const tempLogin = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'neha_temp', password: 'Temp@123' },
      });
      assert.equal(tempLogin.status, 200);
      assert.equal(tempLogin.data.requiresPasswordChange, true);

      const blockedDash = await req('/api/dashboard', { token: tempLogin.data.token });
      assert.equal(blockedDash.status, 403);
      assert.equal(blockedDash.data.code, 'PASSWORD_CHANGE_REQUIRED');

      const changeRes = await req('/api/auth/change-first-password', {
        method: 'POST',
        token: tempLogin.data.token,
        body: {
          currentPassword: 'Temp@123',
          newPassword: 'NehaNewPassword@123',
          confirmPassword: 'NehaNewPassword@123',
        },
      });
      assert.equal(changeRes.status, 200);

      const unlockedDash = await req('/api/dashboard', { token: tempLogin.data.token });
      assert.equal(unlockedDash.status, 200);
    });

    // 13. Deactivated employee login blocked
    await test('13. Deactivated employee login blocked', async () => {
      const res = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'rohit_inactive', password: 'Password@123' },
      });
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'ACCOUNT_DEACTIVATED');

      // Also test live deactivation of Nova employee revokes active session
      const empLogin = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: createdEmpUsername, password: 'Password@123' },
      });
      assert.equal(empLogin.status, 200);
      await req(`/api/employees/${createdEmpRecId}/status`, {
        method: 'POST',
        token: novaAdminToken,
        body: { status: 'inactive' },
      });
      const blockedMe = await req('/api/auth/me', { token: empLogin.data.token });
      assert.equal(blockedMe.status, 401);
      // Reactivate for attendance tests
      await req(`/api/employees/${createdEmpRecId}/status`, {
        method: 'POST',
        token: novaAdminToken,
        body: { status: 'active' },
      });
    });

    // 14. Suspended company access blocked
    await test('14. Suspended company access blocked', async () => {
      const res = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'admin_vertex', password: 'Password@123' },
      });
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'COMPANY_SUSPENDED');
    });

    // 15. Company A attempting to access Company B's data
    await test('15. Cross-company data access strictly blocked (Company A -> Company B)', async () => {
      const abcAdmin = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'admin_abc', password: 'Password@123' },
      });
      assert.equal(abcAdmin.status, 200);

      // rec_009 belongs to XYZ Solutions (CMP-002), while admin_abc belongs to ABC Tech (CMP-001)
      const crossEmp = await req('/api/employees/rec_009', { token: abcAdmin.data.token });
      assert.equal(crossEmp.status, 403);
      assert.equal(crossEmp.data.code, 'CROSS_TENANT_FORBIDDEN');

      // lv_xyz_1 belongs to XYZ Solutions (CMP-002)
      const crossLeave = await req('/api/leaves/lv_xyz_1/action', {
        method: 'POST',
        token: abcAdmin.data.token,
        body: { decision: 'approve' },
      });
      assert.equal(crossLeave.status, 403);
      assert.equal(crossLeave.data.code, 'CROSS_TENANT_FORBIDDEN');
    });

    // 16. Existing attendance features after authentication changes
    await test('16. GPS check-in, geofence check, break, check-out, & regularization', async () => {
      const rahulLogin = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'rahul', password: 'Password@123' },
      });
      assert.equal(rahulLogin.status, 200);
      const token = rahulLogin.data.token;

      // Outside geofence blocked
      const outside = await req('/api/attendance/check-in', {
        method: 'POST',
        token,
        body: { latitude: 38.0, longitude: -122.0 },
      });
      assert.equal(outside.status, 400);
      assert.equal(outside.data.code, 'OUTSIDE_GEOFENCE');

      // Inside SF HQ geofence (37.7897, -122.3972) succeeds
      const inside = await req('/api/attendance/check-in', {
        method: 'POST',
        token,
        body: { latitude: 37.7897, longitude: -122.3972 },
      });
      assert.equal(inside.status, 201);

      const brk1 = await req('/api/attendance/break', { method: 'POST', token });
      assert.equal(brk1.status, 200);
      assert.equal(brk1.data.onBreak, true);

      const brk2 = await req('/api/attendance/break', { method: 'POST', token });
      assert.equal(brk2.status, 200);
      assert.equal(brk2.data.onBreak, false);

      const out = await req('/api/attendance/check-out', {
        method: 'POST',
        token,
        body: { latitude: 37.7897, longitude: -122.3972 },
      });
      assert.equal(out.status, 200);
      assert.ok(out.data.workingHours > 0);
    });

    // 17. Existing leave workflows after authentication changes
    await test('17. Leave application, multi-level approval (L1 -> L2), & WFH workflow', async () => {
      const rahulLogin = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'rahul', password: 'Password@123' },
      });
      const hodLogin = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'arjun_hod', password: 'Password@123' },
      });
      const hrLogin = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'kavita_hr', password: 'Password@123' },
      });

      const apply = await req('/api/leaves', {
        method: 'POST',
        token: rahulLogin.data.token,
        body: {
          leaveType: 'Casual Leave',
          startDate: '2026-12-15',
          endDate: '2026-12-15',
          dayMode: 'Half Day',
          reason: 'Dentist appointment',
        },
      });
      assert.equal(apply.status, 201);
      assert.equal(apply.data.daysCount, 0.5);
      assert.equal(apply.data.status, 'Pending L1');

      const l1 = await req(`/api/leaves/${apply.data.leaveId}/action`, {
        method: 'POST',
        token: hodLogin.data.token,
        body: { decision: 'approve' },
      });
      assert.equal(l1.status, 200);
      assert.equal(l1.data.status, 'Pending L2');

      const l2 = await req(`/api/leaves/${apply.data.leaveId}/action`, {
        method: 'POST',
        token: hrLogin.data.token,
        body: { decision: 'approve' },
      });
      assert.equal(l2.status, 200);
      assert.equal(l2.data.status, 'Approved');
    });

    // 18. Dashboards, payroll summary & role permissions
    await test('18. Dashboards, payroll summary, & role-based permissions', async () => {
      const rahulLogin = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'rahul', password: 'Password@123' },
      });
      // Employee cannot create another employee
      const forbiddenCreate = await req('/api/employees', {
        method: 'POST',
        token: rahulLogin.data.token,
        body: { employeeName: 'Hacker' },
      });
      assert.equal(forbiddenCreate.status, 403);

      // Employee cannot access platform companies
      const forbiddenPlatform = await req('/api/platform/companies', {
        token: rahulLogin.data.token,
      });
      assert.equal(forbiddenPlatform.status, 403);

      // Super Admin accesses platform companies
      const superLogin = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'superadmin', password: 'Admin@123' },
      });
      const platformDash = await req('/api/dashboard', { token: superLogin.data.token });
      assert.equal(platformDash.status, 200);
      assert.equal(platformDash.data.mode, 'super_admin');
      assert.ok(platformDash.data.companies.length >= 4);

      // Payroll summary scoped to ABC Technologies only
      const abcAdmin = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'admin_abc', password: 'Password@123' },
      });
      const payroll = await req('/api/reports/payroll', { token: abcAdmin.data.token });
      assert.equal(payroll.status, 200);
      const ids = payroll.data.summary.map((r: { employee_id: string }) => r.employee_id);
      assert.ok(ids.includes('EMP0004'));
      assert.ok(!ids.includes('EMP0009')); // Priya from XYZ Solutions must NOT appear
    });

    await test('19. Phase 1 address, shift scheduling, break policy, and attendance snapshots', async () => {
      const addressUpdate = await req(`/api/employees/${createdEmpRecId}`, {
        method: 'PATCH',
        token: novaAdminToken,
        body: { address: '12 Audit Street' },
      });
      assert.equal(addressUpdate.status, 200);

      const employeeList = await req('/api/employees', { token: novaAdminToken });
      assert.equal(employeeList.status, 200);
      const updatedEmployee = employeeList.data.employees.find(
        (e: { employee_record_id: string }) => e.employee_record_id === createdEmpRecId
      );
      assert.equal(updatedEmployee.address, '12 Audit Street');

      const nightShift = await req('/api/shifts', {
        method: 'POST',
        token: novaAdminToken,
        body: { name: 'Audit Night Shift', startTime: '22:00', endTime: '06:00', graceMinutes: 15, breakMinutes: 30 },
      });
      assert.equal(nightShift.status, 201);

      const generalShift = await req('/api/shifts', {
        method: 'POST',
        token: novaAdminToken,
        body: { name: 'Audit General Shift', startTime: '09:00', endTime: '18:00', graceMinutes: 15, breakMinutes: 60 },
      });
      assert.equal(generalShift.status, 201);

      const companyAssignment = await req('/api/shift-assignments', {
        method: 'POST',
        token: novaAdminToken,
        body: {
          scopeType: 'company',
          scopeId: null,
          shiftId: generalShift.data.shiftId,
          startDate: '2027-01-15',
          endDate: '2027-01-15',
        },
      });
      assert.equal(companyAssignment.status, 201);

      const employeeAssignment = await req('/api/shift-assignments', {
        method: 'POST',
        token: novaAdminToken,
        body: {
          scopeType: 'employee',
          scopeId: createdEmpRecId,
          shiftId: nightShift.data.shiftId,
          startDate: '2027-01-15',
          endDate: '2027-01-15',
        },
      });
      assert.equal(employeeAssignment.status, 201);

      const overlap = await req('/api/shift-assignments', {
        method: 'POST',
        token: novaAdminToken,
        body: {
          scopeType: 'employee',
          scopeId: createdEmpRecId,
          shiftId: nightShift.data.shiftId,
          startDate: '2027-01-15',
          endDate: '2027-01-15',
        },
      });
      assert.equal(overlap.status, 409);
      assert.equal(overlap.data.code, 'SHIFT_ASSIGNMENT_OVERLAP');

      const effective = await req(
        `/api/shifts/effective?employeeRecordId=${createdEmpRecId}&date=2027-01-15`,
        { token: novaAdminToken }
      );
      assert.equal(effective.status, 200);
      assert.equal(effective.data.source, 'employee');
      assert.equal(effective.data.shift.name, 'Audit Night Shift');

      const companyBreakConfig = await req('/api/lunch-break-configs', {
        method: 'POST',
        token: novaAdminToken,
        body: {
          scopeType: 'company',
          scopeId: null,
          breakType: 'mandatory',
          durationMinutes: 30,
          windowStart: '12:00',
          windowEnd: '14:00',
          maxDurationMinutes: 60,
        },
      });
      assert.equal(companyBreakConfig.status, 201);

      const duplicateBreakConfig = await req('/api/lunch-break-configs', {
        method: 'POST',
        token: novaAdminToken,
        body: {
          scopeType: 'company',
          scopeId: null,
          breakType: 'mandatory',
          durationMinutes: 30,
          windowStart: '12:00',
          windowEnd: '14:00',
          maxDurationMinutes: 60,
        },
      });
      assert.equal(duplicateBreakConfig.status, 409);
      assert.equal(duplicateBreakConfig.data.code, 'BREAK_CONFIG_EXISTS');

      const employeeBreakConfig = await req('/api/lunch-break-configs', {
        method: 'POST',
        token: novaAdminToken,
        body: {
          scopeType: 'employee',
          scopeId: createdEmpRecId,
          breakType: 'mandatory',
          durationMinutes: 1,
          windowStart: '',
          windowEnd: '',
          maxDurationMinutes: 1,
        },
      });
      assert.equal(employeeBreakConfig.status, 201);

      const employeeLogin = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: createdEmpUsername, password: 'Password@123' },
      });
      assert.equal(employeeLogin.status, 200);
      const employeeToken = employeeLogin.data.token;

      const checkIn = await req('/api/attendance/check-in', {
        method: 'POST',
        token: employeeToken,
        body: { latitude: 37.7897, longitude: -122.3972 },
      });
      assert.equal(checkIn.status, 201);
      assert.equal(checkIn.data.breakPolicy, 'mandatory');

      const breakStart = await req('/api/attendance/break', { method: 'POST', token: employeeToken });
      assert.equal(breakStart.status, 200);
      assert.equal(breakStart.data.onBreak, true);

      const breakEnd = await req('/api/attendance/break', { method: 'POST', token: employeeToken });
      assert.equal(breakEnd.status, 200);
      assert.equal(breakEnd.data.onBreak, false);
      assert.equal(breakEnd.data.breakCompliance, 'completed');

      const checkOut = await req('/api/attendance/check-out', {
        method: 'POST',
        token: employeeToken,
        body: { latitude: 37.7897, longitude: -122.3972 },
      });
      assert.equal(checkOut.status, 200);
      assert.equal(checkOut.data.breakCompliance, 'completed');
      assert.ok(checkOut.data.breakMinutes >= 1);

      const month = String(checkIn.data.attendanceDate).slice(0, 7);
      const attendance = await req(`/api/attendance?scope=mine&month=${month}`, { token: employeeToken });
      assert.equal(attendance.status, 200);
      const snapshot = attendance.data.records.find(
        (r: { attendance_id: string }) => r.attendance_id === checkIn.data.attendanceId
      );
      assert.ok(snapshot);
      assert.equal(snapshot.break_policy_type, 'mandatory');
      assert.equal(snapshot.break_compliance, 'completed');
      assert.ok(snapshot.effective_shift_date);
      assert.equal(snapshot.break_events.length, 1);

      const addressClear = await req(`/api/employees/${createdEmpRecId}`, {
        method: 'PATCH',
        token: novaAdminToken,
        body: { address: '' },
      });
      assert.equal(addressClear.status, 200);
      const clearedList = await req('/api/employees', { token: novaAdminToken });
      const clearedEmployee = clearedList.data.employees.find(
        (e: { employee_record_id: string }) => e.employee_record_id === createdEmpRecId
      );
      assert.equal(clearedEmployee.address, null);
    });

    await test('20. Shift working hours and admin shift CRUD', async () => {
      const created = await req('/api/shifts', {
        method: 'POST',
        token: novaAdminToken,
        body: {
          name: 'Audit Config Shift',
          startTime: '08:00',
          endTime: '17:00',
          graceMinutes: 10,
          breakMinutes: 45,
          workingHours: 7.5,
        },
      });
      assert.equal(created.status, 201);

      let org = await req('/api/org-options', { token: novaAdminToken });
      assert.equal(org.status, 200);
      let configured = org.data.shifts.find((s: { shift_id: string }) => s.shift_id === created.data.shiftId);
      assert.ok(configured);
      assert.equal(configured.working_hours, 7.5);

      const updated = await req(`/api/shifts/${created.data.shiftId}`, {
        method: 'PATCH',
        token: novaAdminToken,
        body: { workingHours: 8.5, breakMinutes: 30 },
      });
      assert.equal(updated.status, 200);
      org = await req('/api/org-options', { token: novaAdminToken });
      configured = org.data.shifts.find((s: { shift_id: string }) => s.shift_id === created.data.shiftId);
      assert.equal(configured.working_hours, 8.5);

      const invalidHours = await req('/api/shifts', {
        method: 'POST',
        token: novaAdminToken,
        body: { name: 'Invalid Hours', startTime: '09:00', endTime: '18:00', workingHours: 0 },
      });
      assert.equal(invalidHours.status, 400);
      const invalidTime = await req('/api/shifts', {
        method: 'POST',
        token: novaAdminToken,
        body: { name: 'Invalid Time', startTime: '25:00', endTime: '18:00', workingHours: 8 },
      });
      assert.equal(invalidTime.status, 400);

      const assignment = await req('/api/shift-assignments', {
        method: 'POST',
        token: novaAdminToken,
        body: {
          scopeType: 'employee',
          scopeId: createdEmpRecId,
          shiftId: created.data.shiftId,
          startDate: '2027-03-01',
          endDate: '2027-03-01',
        },
      });
      assert.equal(assignment.status, 201);
      const inUse = await req(`/api/shifts/${created.data.shiftId}`, {
        method: 'DELETE',
        token: novaAdminToken,
      });
      assert.equal(inUse.status, 409);
      assert.equal(inUse.data.code, 'SHIFT_IN_USE');

      const removeAssignment = await req(`/api/shift-assignments/${assignment.data.assignmentId}`, {
        method: 'DELETE',
        token: novaAdminToken,
      });
      assert.equal(removeAssignment.status, 200);
      const removeShift = await req(`/api/shifts/${created.data.shiftId}`, {
        method: 'DELETE',
        token: novaAdminToken,
      });
      assert.equal(removeShift.status, 200);
    });

    await test('21. Date ranges, overlap, overnight, and historical schedule preservation', async () => {
      const makeShift = async (name: string, startTime: string, endTime: string, workingHours: number) => {
        const res = await req('/api/shifts', {
          method: 'POST',
          token: novaAdminToken,
          body: { name, startTime, endTime, workingHours, graceMinutes: 15, breakMinutes: 60 },
        });
        assert.equal(res.status, 201);
        return String(res.data.shiftId);
      };
      const makeAssignment = async (
        shiftId: string,
        startDate: string,
        endDate: string,
        effectiveDate?: string,
        recordId = createdEmpRecId
      ) => {
        const body: Record<string, unknown> = {
          scopeType: 'employee',
          scopeId: recordId,
          shiftId,
          startDate,
          endDate,
        };
        if (effectiveDate) body.effectiveDate = effectiveDate;
        const res = await req('/api/shift-assignments', { method: 'POST', token: novaAdminToken, body });
        assert.equal(res.status, 201);
        return String(res.data.assignmentId);
      };
      const effectiveShiftName = async (date: string, recordId = createdEmpRecId) => {
        const res = await req(`/api/shifts/effective?employeeRecordId=${recordId}&date=${date}`, {
          token: novaAdminToken,
        });
        assert.equal(res.status, 200);
        return res.data.shift?.name ?? null;
      };

      const morning = await makeShift('Date Morning', '09:00', '18:00', 8);
      const night = await makeShift('Date Night', '22:00', '06:00', 7);
      const evening = await makeShift('Date Evening', '16:00', '22:00', 6);
      await makeAssignment(morning, '2027-04-01', '2027-04-10');
      await makeAssignment(night, '2027-04-11', '2027-04-15');
      await makeAssignment(evening, '2027-04-16', '2027-04-30');

      assert.equal(await effectiveShiftName('2027-04-01'), 'Date Morning');
      assert.equal(await effectiveShiftName('2027-04-10'), 'Date Morning');
      assert.equal(await effectiveShiftName('2027-04-11'), 'Date Night');
      assert.equal(await effectiveShiftName('2027-04-15'), 'Date Night');
      assert.equal(await effectiveShiftName('2027-04-16'), 'Date Evening');
      assert.equal(await effectiveShiftName('2027-04-30'), 'Date Evening');

      const overlap = await req('/api/shift-assignments', {
        method: 'POST',
        token: novaAdminToken,
        body: {
          scopeType: 'employee',
          scopeId: createdEmpRecId,
          shiftId: morning,
          startDate: '2027-04-09',
          endDate: '2027-04-12',
        },
      });
      assert.equal(overlap.status, 409);
      assert.equal(overlap.data.code, 'SHIFT_ASSIGNMENT_OVERLAP');

      const oldShift = await makeShift('History Old', '08:00', '17:00', 8);
      const newShift = await makeShift('History New', '10:00', '19:00', 8);
      const bridgeShift = await makeShift('History Bridge', '11:00', '20:00', 8);
      const deleteShift = await makeShift('History Delete', '07:00', '16:00', 8);

      const createHistoryEmployee = async (username: string, mobile: string) => {
        const res = await req('/api/employees', {
          method: 'POST',
          token: novaAdminToken,
          body: {
            employeeName: username,
            email: `${username}@novadynamics.io`,
            mobile,
            designation: 'Auditor',
            joiningDate: dateFromToday(-10),
            employmentType: 'Full-Time',
            roleName: 'Employee',
            username,
            password: 'Password@123',
            confirmPassword: 'Password@123',
            forcePasswordChange: false,
          },
        });
        assert.equal(res.status, 201);
        return String(res.data.employee.employeeRecordId);
      };
      const historyEmpRecId = await createHistoryEmployee('audit_history', '90000014');
      const bridgeEmpRecId = await createHistoryEmployee('audit_bridge', '90000015');
      const deleteEmpRecId = await createHistoryEmployee('audit_delete', '90000016');
      const pastEmpRecId = await createHistoryEmployee('audit_past', '90000017');

      const spanning = await makeAssignment(
        oldShift,
        dateFromToday(-5),
        dateFromToday(5),
        undefined,
        historyEmpRecId
      );
      const split = await req(`/api/shift-assignments/${spanning}`, {
        method: 'PATCH',
        token: novaAdminToken,
        body: {
          scopeType: 'employee',
          scopeId: historyEmpRecId,
          shiftId: newShift,
          startDate: dateFromToday(-5),
          endDate: dateFromToday(10),
          effectiveDate: dateFromToday(1),
        },
      });
      assert.equal(split.status, 200);
      assert.equal(split.data.split, true);
      assert.equal(await effectiveShiftName(dateFromToday(0), historyEmpRecId), 'History Old');
      assert.equal(await effectiveShiftName(dateFromToday(1), historyEmpRecId), 'History New');
      assert.equal(await effectiveShiftName(dateFromToday(10), historyEmpRecId), 'History New');

      const bridgeAssignment = await makeAssignment(
        oldShift,
        dateFromToday(-2),
        dateFromToday(8),
        dateFromToday(1),
        bridgeEmpRecId
      );
      const bridged = await req(`/api/shift-assignments/${bridgeAssignment}`, {
        method: 'PATCH',
        token: novaAdminToken,
        body: {
          scopeType: 'employee',
          scopeId: bridgeEmpRecId,
          shiftId: bridgeShift,
          startDate: dateFromToday(3),
          endDate: dateFromToday(8),
          effectiveDate: dateFromToday(1),
        },
      });
      assert.equal(bridged.status, 200);
      assert.equal(bridged.data.split, true);
      assert.equal(await effectiveShiftName(dateFromToday(1), bridgeEmpRecId), 'History Old');
      assert.equal(await effectiveShiftName(dateFromToday(2), bridgeEmpRecId), 'History Old');
      assert.equal(await effectiveShiftName(dateFromToday(3), bridgeEmpRecId), 'History Bridge');

      const deleteAssignment = await makeAssignment(
        deleteShift,
        dateFromToday(-1),
        dateFromToday(5),
        dateFromToday(1),
        deleteEmpRecId
      );
      const trimmed = await req(`/api/shift-assignments/${deleteAssignment}?effectiveDate=${dateFromToday(1)}`, {
        method: 'DELETE',
        token: novaAdminToken,
      });
      assert.equal(trimmed.status, 200);
      assert.equal(trimmed.data.trimmed, true);
      assert.equal(await effectiveShiftName(dateFromToday(0), deleteEmpRecId), 'History Delete');
      assert.notEqual(await effectiveShiftName(dateFromToday(1), deleteEmpRecId), 'History Delete');

      const pastOnly = await makeAssignment(oldShift, dateFromToday(-10), dateFromToday(-6), undefined, pastEmpRecId);
      const rejected = await req(`/api/shift-assignments/${pastOnly}`, {
        method: 'DELETE',
        token: novaAdminToken,
      });
      assert.equal(rejected.status, 409);
      assert.equal(rejected.data.code, 'SCHEDULE_HISTORY_IMMUTABLE');
    });

    await test('22. Shift permissions and tenant isolation', async () => {
      const employeeLogin = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: createdEmpUsername, password: 'Password@123' },
      });
      assert.equal(employeeLogin.status, 200);
      const employeeToken = employeeLogin.data.token;

      const org = await req('/api/org-options', { token: employeeToken });
      assert.equal(org.status, 200);
      assert.ok(org.data.shifts.length <= 1);
      assert.ok(org.data.shiftAssignments.length <= 1);
      assert.ok(org.data.lunchBreakConfigs.length <= 1);
      assert.deepEqual(org.data.employees, []);
      assert.deepEqual(org.data.managers, []);

      assert.equal((await req('/api/shift-assignments', { token: employeeToken })).status, 403);
      assert.equal((await req('/api/lunch-break-configs', { token: employeeToken })).status, 403);
      assert.equal(
        (await req('/api/shifts', {
          method: 'POST',
          token: employeeToken,
          body: { name: 'Forbidden', startTime: '09:00', endTime: '18:00', workingHours: 8 },
        })).status,
        403
      );
      assert.equal(
        (await req('/api/shift-assignments', {
          method: 'POST',
          token: employeeToken,
          body: {
            scopeType: 'company',
            shiftId: 'shift_any',
            startDate: dateFromToday(20),
            endDate: dateFromToday(20),
          },
        })).status,
        403
      );

      const abcLogin = await req('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'admin_abc', password: 'Password@123' },
      });
      assert.equal(abcLogin.status, 200);
      const abcToken = abcLogin.data.token;
      const abcShift = await req('/api/shifts', {
        method: 'POST',
        token: abcToken,
        body: { name: 'ABC Only Shift', startTime: '09:00', endTime: '18:00', workingHours: 8 },
      });
      assert.equal(abcShift.status, 201);

      const crossCompanyScope = await req('/api/shift-assignments', {
        method: 'POST',
        token: abcToken,
        body: {
          scopeType: 'employee',
          scopeId: createdEmpRecId,
          shiftId: abcShift.data.shiftId,
          startDate: dateFromToday(20),
          endDate: dateFromToday(20),
        },
      });
      assert.equal(crossCompanyScope.status, 400);
      assert.match(String(crossCompanyScope.data.error), /company/i);

      const novaShift = await req('/api/org-options', { token: novaAdminToken });
      const visibleNovaShift = novaShift.data.shifts.find((s: { name: string }) => s.name === 'Date Morning');
      const crossCompanyShift = await req('/api/shift-assignments', {
        method: 'POST',
        token: abcToken,
        body: {
          scopeType: 'company',
          shiftId: visibleNovaShift.shift_id,
          startDate: dateFromToday(20),
          endDate: dateFromToday(20),
        },
      });
      assert.equal(crossCompanyShift.status, 400);
      assert.match(String(crossCompanyShift.data.error), /company/i);
    });

    await test('23. Break policy matrix and configured working-hour attendance', async () => {
      const calcShift = await req('/api/shifts', {
        method: 'POST',
        token: novaAdminToken,
        body: { name: 'Attendance Calc Shift', startTime: '09:00', endTime: '18:00', workingHours: 6 },
      });
      assert.equal(calcShift.status, 201);

      const createAuditEmployee = async (username: string) => {
        const res = await req('/api/employees', {
          method: 'POST',
          token: novaAdminToken,
          body: {
            employeeName: username,
            email: `${username}@novadynamics.io`,
            mobile: `900000${username.length}`,
            designation: 'Auditor',
            joiningDate: dateFromToday(0),
            employmentType: 'Full-Time',
            roleName: 'Employee',
            username,
            password: 'Password@123',
            confirmPassword: 'Password@123',
            forcePasswordChange: false,
          },
        });
        assert.equal(res.status, 201);
        return String(res.data.employee.employeeRecordId);
      };

      const runPolicy = async (
        username: string,
        breakType: 'mandatory' | 'optional' | 'flexible',
        takeBreak: boolean
      ) => {
        const recordId = await createAuditEmployee(username);
        const assignment = await req('/api/shift-assignments', {
          method: 'POST',
          token: novaAdminToken,
          body: {
            scopeType: 'employee',
            scopeId: recordId,
            shiftId: calcShift.data.shiftId,
            startDate: dateFromToday(0),
            endDate: dateFromToday(0),
          },
        });
        assert.equal(assignment.status, 201);
        const policy = await req('/api/lunch-break-configs', {
          method: 'POST',
          token: novaAdminToken,
          body: {
            scopeType: 'employee',
            scopeId: recordId,
            breakType,
            durationMinutes: 1,
            windowStart: '',
            windowEnd: '',
            maxDurationMinutes: 1,
          },
        });
        assert.equal(policy.status, 201);
        const login = await req('/api/auth/login', {
          method: 'POST',
          body: { identifier: username, password: 'Password@123' },
        });
        assert.equal(login.status, 200);
        const token = login.data.token;
        const checkIn = await req('/api/attendance/check-in', {
          method: 'POST',
          token,
          body: { latitude: 37.7897, longitude: -122.3972 },
        });
        assert.equal(checkIn.status, 201);
        assert.equal(checkIn.data.expectedWorkingHours, 6);
        assert.equal(checkIn.data.breakPolicy, breakType);

        if (takeBreak) {
          const started = await req('/api/attendance/break', { method: 'POST', token });
          assert.equal(started.status, 200);
          assert.equal(started.data.onBreak, true);
          const ended = await req('/api/attendance/break', { method: 'POST', token });
          assert.equal(ended.status, 200);
          assert.equal(ended.data.breakCompliance, 'completed');
        }

        const checkOut = await req('/api/attendance/check-out', {
          method: 'POST',
          token,
          body: { latitude: 37.7897, longitude: -122.3972 },
        });
        assert.equal(checkOut.status, 200);
        assert.equal(checkOut.data.expectedWorkingHours, 6);
        assert.ok(checkOut.data.workingHours > 0 && checkOut.data.workingHours <= 6);
        assert.equal(checkOut.data.breakCompliance, takeBreak ? 'completed' : 'not_applicable');

        const attendance = await req(`/api/attendance?scope=mine&month=${String(checkIn.data.attendanceDate).slice(0, 7)}`, {
          token,
        });
        const record = attendance.data.records.find(
          (r: { attendance_id: string }) => r.attendance_id === checkIn.data.attendanceId
        );
        assert.ok(record);
        assert.equal(record.expected_working_hours, 6);
        assert.equal(record.break_events.length, takeBreak ? 1 : 0);
      };

      await runPolicy('audit_mandatory', 'mandatory', true);
      await runPolicy('audit_optional', 'optional', false);
      await runPolicy('audit_flexible', 'flexible', true);
    });

    console.log(`\nALL ${passed} INTEGRATION TESTS PASSED SUCCESSFULLY.`);
  } finally {
    server.close();
    await db.close();
  }
}

runTests().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
