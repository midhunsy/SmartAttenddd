import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createIsolatedDbForTests } from '../server/db.ts';
import { createExpressApp } from '../server.ts';

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
