import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { createIsolatedDbForTests } from '../server/db.ts';
import { createExpressApp } from '../server.ts';
import { calculateAccrualDays, type LeavePolicyRow } from '../server/services/enterpriseLeave.ts';

async function runTests() {
  const db = await createIsolatedDbForTests();
  const app = createExpressApp(db);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function req(
    urlPath: string,
    options: { method?: string; token?: string; body?: unknown } = {}
  ) {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
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

  const today = new Date().toISOString().slice(0, 10);
  const addDays = (date: string, days: number): string => {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  };

  async function registerCompany(suffix: string) {
    const res = await req('/api/auth/register-company', {
      method: 'POST',
      body: {
        companyName: `Enterprise ${suffix} Labs`,
        companyEmail: `enterprise.${suffix}@example.test`,
        contactNumber: '+1 555-0100',
        industry: 'Software',
        address: `1 ${suffix} Street`,
        adminFullName: `Enterprise ${suffix} Admin`,
        adminEmail: `admin.${suffix}@example.test`,
        adminMobile: '+1 555-0101',
        username: `ent_${suffix}_admin`,
        password: 'Password@123',
        confirmPassword: 'Password@123',
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return {
      token: res.data.token as string,
      companyId: res.data.user.companyId as string,
      adminRecordId: res.data.user.employeeRecordId as string,
    };
  }

  async function createEmployee(
    adminToken: string,
    username: string,
    joiningDate: string,
    roleName = 'Employee'
  ) {
    const res = await req('/api/employees', {
      method: 'POST',
      token: adminToken,
      body: {
        employeeName: username.replace(/_/g, ' '),
        email: `${username}@example.test`,
        mobile: '+1 555-0102',
        designation: 'Test Engineer',
        joiningDate,
        roleName,
        username,
        password: 'Password@123',
        confirmPassword: 'Password@123',
        forcePasswordChange: false,
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data.employee as {
      employeeRecordId: string;
      employeeId: string;
      userId: string;
      role: string;
    };
  }

  async function login(username: string): Promise<string> {
    const res = await req('/api/auth/login', {
      method: 'POST',
      body: { identifier: username, password: 'Password@123' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data.token as string;
  }

  try {
    const companyA = await registerCompany('alpha');
    const companyB = await registerCompany('bravo');
    assert.notEqual(companyA.companyId, companyB.companyId);

    const employeeA = await createEmployee(companyA.token, 'ent_alpha_employee', '2020-01-01');
    const proratedEmployee = await createEmployee(companyA.token, 'ent_alpha_prorated', '2026-06-15');
    const employeeB = await createEmployee(companyB.token, 'ent_bravo_employee', '2020-01-01');
    const employeeAToken = await login('ent_alpha_employee');
    const employeeBToken = await login('ent_bravo_employee');

    let casualPolicyId = '';
    let requestId = '';
    let eveningShiftId = '';
    let leaveId = '';
    let claimId = '';

    await test('1. Company-specific policies, accrual proration, duplicates, and immutable ledger history', async () => {
      const casual = await req('/api/leave-policies', {
        method: 'POST',
        token: companyA.token,
        body: {
          leaveType: 'Casual Leave',
          accrualMethod: 'Monthly',
          monthlyEntitlement: 1.5,
          creditDay: 1,
          effectiveFrom: '2020-01-01',
        },
      });
      assert.equal(casual.status, 201, JSON.stringify(casual.data));
      casualPolicyId = casual.data.policyId as string;

      const earned = await req('/api/leave-policies', {
        method: 'POST',
        token: companyA.token,
        body: {
          leaveType: 'Earned Leave',
          accrualMethod: 'Annual',
          annualEntitlement: 18,
          creditDay: 1,
          effectiveFrom: '2020-01-01',
        },
      });
      assert.equal(earned.status, 201, JSON.stringify(earned.data));

      const monthly = await req(`/api/leave-policies/${casualPolicyId}/accrue`, {
        method: 'POST',
        token: companyA.token,
        body: { period: '2026-06', employeeIds: [employeeA.employeeRecordId] },
      });
      assert.equal(monthly.status, 200, JSON.stringify(monthly.data));
      assert.ok(monthly.data.credits.some((entry: string) => entry.includes('1.5')), JSON.stringify(monthly.data));

      const prorated = await req(`/api/leave-policies/${casualPolicyId}/accrue`, {
        method: 'POST',
        token: companyA.token,
        body: { period: '2026-06', employeeIds: [proratedEmployee.employeeRecordId] },
      });
      assert.equal(prorated.status, 200, JSON.stringify(prorated.data));
      assert.ok(prorated.data.credits.some((entry: string) => entry.includes('0.8')), JSON.stringify(prorated.data));

      const annual = await req(`/api/leave-policies/${earned.data.policyId}/accrue`, {
        method: 'POST',
        token: companyA.token,
        body: { period: '2026-01', employeeIds: [employeeA.employeeRecordId] },
      });
      assert.equal(annual.status, 200, JSON.stringify(annual.data));
      assert.ok(annual.data.credits.some((entry: string) => entry.includes('18')), JSON.stringify(annual.data));

      const policies = await req('/api/leave-policies', { token: companyA.token });
      assert.equal(policies.status, 200);
      assert.equal(policies.data.policies.length, 2);
      const policy = policies.data.policies.find((row: LeavePolicyRow) => row.leave_type === 'Earned Leave');
      assert.ok(policy);
      assert.equal(calculateAccrualDays(policy as LeavePolicyRow, '2026-03-10', '2026-06'), 15);

      const duplicate = await req(`/api/leave-policies/${casualPolicyId}/accrue`, {
        method: 'POST',
        token: companyA.token,
        body: { period: '2026-06', employeeIds: [employeeA.employeeRecordId] },
      });
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.data.credits.length, 0);
      assert.ok(duplicate.data.skipped.some((entry: string) => entry.includes('already accrued')));

      const changed = await req(`/api/leave-policies/${casualPolicyId}`, {
        method: 'PUT',
        token: companyA.token,
        body: { monthlyEntitlement: 2, effectiveFrom: addDays(today, 1) },
      });
      assert.equal(changed.status, 200, JSON.stringify(changed.data));
      assert.notEqual(changed.data.policyId, casualPolicyId);

      const ledger = await req(
        `/api/leave-ledger?employeeId=${employeeA.employeeRecordId}&leaveType=${encodeURIComponent('Casual Leave')}`,
        { token: companyA.token }
      );
      assert.equal(ledger.status, 200);
      assert.ok(
        ledger.data.ledger.some(
          (row: Record<string, unknown>) =>
            row.policy_id === casualPolicyId && row.entry_type === 'Accrual' && row.days === 1.5
        ),
        JSON.stringify(ledger.data.ledger)
      );

      const afterUpdate = await req('/api/leave-policies', { token: companyA.token });
      assert.ok(!afterUpdate.data.policies.some((row: LeavePolicyRow) => row.policy_id === casualPolicyId));
      assert.ok(afterUpdate.data.history.some((row: Record<string, unknown>) => row.action === 'SUPERSEDED'));
    });

    await test('2. Leave final approval writes a Deduction ledger row and reduces available balance', async () => {
      const before = await req('/api/leave-overview', { token: employeeAToken });
      assert.equal(before.status, 200);
      const beforeBalance = before.data.balances.find((row: Record<string, unknown>) => row.leave_type === 'Casual Leave');
      assert.ok(beforeBalance);

      const leaveStart = addDays(today, 5);
      const submitted = await req('/api/leaves', {
        method: 'POST',
        token: employeeAToken,
        body: {
          leaveType: 'Casual Leave',
          startDate: leaveStart,
          endDate: leaveStart,
          dayMode: 'Full Day',
          reason: 'Family commitment',
        },
      });
      assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
      leaveId = submitted.data.leaveId as string;

      const approved = await req(`/api/leaves/${leaveId}/action`, {
        method: 'POST',
        token: companyA.token,
        body: { decision: 'approve', comment: 'Approved by admin' },
      });
      assert.equal(approved.status, 200, JSON.stringify(approved.data));
      assert.equal(approved.data.status, 'Approved');

      const after = await req('/api/leave-overview', { token: employeeAToken });
      const afterBalance = after.data.balances.find((row: Record<string, unknown>) => row.leave_type === 'Casual Leave');
      assert.ok(afterBalance);
      assert.ok(Math.abs(Number(beforeBalance.available_days) - Number(afterBalance.available_days) - 1) < 0.01);

      const ledger = await req(
        `/api/leave-ledger?employeeId=${employeeA.employeeRecordId}&leaveType=${encodeURIComponent('Casual Leave')}`,
        { token: employeeAToken }
      );
      const deduction = ledger.data.ledger.find(
        (row: Record<string, unknown>) => row.reference_id === `LEAVE:${leaveId}`
      );
      assert.ok(deduction, JSON.stringify(ledger.data.ledger));
      assert.equal(deduction.entry_type, 'Deduction');
      assert.equal(deduction.days, -1);
    });

    await test('3. Shift change approval, conflict rejection, override, and employee cannot approve', async () => {
      const evening = await req('/api/shifts', {
        method: 'POST',
        token: companyA.token,
        body: { name: 'Evening Shift', startTime: '14:00', endTime: '22:00' },
      });
      assert.equal(evening.status, 201);
      eveningShiftId = evening.data.shiftId as string;
      const night = await req('/api/shifts', {
        method: 'POST',
        token: companyA.token,
        body: { name: 'Night Shift', startTime: '22:00', endTime: '06:00' },
      });
      assert.equal(night.status, 201);

      const start = addDays(today, 20);
      const end = addDays(today, 21);
      const invalid = await req('/api/shift-change-requests', {
        method: 'POST',
        token: employeeAToken,
        body: { requestedShiftId: eveningShiftId, startDate: start, endDate: end, reason: '   ' },
      });
      assert.equal(invalid.status, 400, JSON.stringify(invalid.data));
      assert.equal(invalid.data.error, 'A valid shift, date range, and reason are required.');

      const submitted = await req('/api/shift-change-requests', {
        method: 'POST',
        token: employeeAToken,
        body: { requestedShiftId: eveningShiftId, startDate: start, endDate: end, reason: 'Project handover' },
      });
      assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
      assert.equal(submitted.data.status, 'Pending');
      requestId = submitted.data.requestId as string;

      const persisted = db
        .prepare('SELECT * FROM shift_change_requests WHERE request_id = ?')
        .get(requestId) as Record<string, unknown> | undefined;
      assert.ok(persisted, 'submitted shift change request must be persisted');
      assert.equal(persisted.company_id, companyA.companyId);
      assert.equal(persisted.employee_record_id, employeeA.employeeRecordId);
      assert.equal(persisted.requested_shift_id, eveningShiftId);
      assert.equal(persisted.start_date, start);
      assert.equal(persisted.end_date, end);
      assert.equal(persisted.reason, 'Project handover');
      assert.equal(persisted.status, 'Pending');

      const ownRequests = await req('/api/shift-change-requests', { token: employeeAToken });
      assert.equal(ownRequests.status, 200);
      assert.ok(
        ownRequests.data.requests.some((row: Record<string, unknown>) => row.request_id === requestId),
        JSON.stringify(ownRequests.data.requests)
      );

      const denied = await req(`/api/shift-change-requests/${requestId}/action`, {
        method: 'POST',
        token: employeeAToken,
        body: { decision: 'approve' },
      });
      assert.equal(denied.status, 403);

      const approved = await req(`/api/shift-change-requests/${requestId}/action`, {
        method: 'POST',
        token: companyA.token,
        body: { decision: 'approve', comment: 'Covered by Evening Shift' },
      });
      assert.equal(approved.status, 200, JSON.stringify(approved.data));
      assert.equal(approved.data.status, 'Approved');

      const override = db
        .prepare('SELECT * FROM shift_schedule_overrides WHERE request_id = ?')
        .get(requestId) as Record<string, unknown> | undefined;
      assert.ok(override, 'approval must create a schedule override');
      assert.equal(override.company_id, companyA.companyId);
      assert.equal(override.employee_record_id, employeeA.employeeRecordId);
      assert.equal(override.shift_id, eveningShiftId);

      const reassigned = db
        .prepare('SELECT assigned_shift_id FROM employees WHERE employee_record_id = ?')
        .get(employeeA.employeeRecordId) as { assigned_shift_id: string } | undefined;
      assert.equal(reassigned?.assigned_shift_id, eveningShiftId);

      const overlapping = await req('/api/shift-change-requests', {
        method: 'POST',
        token: employeeAToken,
        body: { requestedShiftId: night.data.shiftId, startDate: start, endDate: end, reason: 'Different shift' },
      });
      assert.equal(overlapping.status, 201);
      const conflict = await req(`/api/shift-change-requests/${overlapping.data.requestId}/action`, {
        method: 'POST',
        token: companyA.token,
        body: { decision: 'approve' },
      });
      assert.equal(conflict.status, 409, JSON.stringify(conflict.data));
      assert.equal(conflict.data.error, 'Scheduling conflict detected.');
      assert.ok(conflict.data.conflicts.length > 0);

      const laterStart = addDays(today, 30);
      const nonConflicting = await req('/api/shift-change-requests', {
        method: 'POST',
        token: employeeAToken,
        body: {
          requestedShiftId: night.data.shiftId,
          startDate: laterStart,
          endDate: addDays(today, 31),
          reason: 'Night rollout',
        },
      });
      assert.equal(nonConflicting.status, 201);
      const approvedLater = await req(`/api/shift-change-requests/${nonConflicting.data.requestId}/action`, {
        method: 'POST',
        token: companyA.token,
        body: { decision: 'approve' },
      });
      assert.equal(approvedLater.status, 200, JSON.stringify(approvedLater.data));

      const employeeDetail = await req(`/api/employees/${employeeA.employeeRecordId}`, { token: companyA.token });
      assert.equal(employeeDetail.data.employee.assigned_shift_id, night.data.shiftId);
      const schedule = await req(`/api/shift-schedule?date=${laterStart}`, { token: employeeAToken });
      assert.equal(schedule.status, 200);
      assert.equal(schedule.data.effectiveShift.shiftId, night.data.shiftId);
      assert.ok(schedule.data.overrides.length > 0);
    });

    await test('4. Expense claim with receipt, info/approve/pay transitions, and grouped reports', async () => {
      const receipt = `data:application/pdf;base64,${Buffer.from('receipt-fixture').toString('base64')}`;
      const created = await req('/api/expense-claims', {
        method: 'POST',
        token: employeeAToken,
        body: {
          visitDate: addDays(today, 2),
          location: 'Client Site',
          client: 'Acme Corp',
          businessPurpose: 'On-site discovery workshop',
          items: [
            {
              category: 'Transportation',
              amount: 25.5,
              description: 'Train fare',
              receiptFileName: 'train.pdf',
              receiptContentType: 'application/pdf',
              receiptDataUrl: receipt,
            },
            { category: 'Food', amount: 12.25, description: 'Lunch' },
          ],
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      assert.equal(created.data.status, 'Pending');
      assert.equal(created.data.totalAmount, 37.75);
      claimId = created.data.claimId as string;

      const detail = await req(`/api/expense-claims/${claimId}`, { token: employeeAToken });
      assert.equal(detail.status, 200);
      assert.equal(detail.data.items.length, 2);
      assert.ok(detail.data.items.some((item: Record<string, unknown>) => item.receipt_data_url === receipt));

      const info = await req(`/api/expense-claims/${claimId}/action`, {
        method: 'POST',
        token: companyA.token,
        body: { decision: 'request-info', comment: 'Attach the taxi receipt' },
      });
      assert.equal(info.status, 200);
      assert.equal(info.data.approvalStatus, 'Needs Info');

      const approved = await req(`/api/expense-claims/${claimId}/action`, {
        method: 'POST',
        token: companyA.token,
        body: { decision: 'approve', comment: 'All receipts verified' },
      });
      assert.equal(approved.status, 200);
      assert.equal(approved.data.approvalStatus, 'Approved');

      const payDenied = await req(`/api/expense-claims/${claimId}/pay`, {
        method: 'POST',
        token: employeeAToken,
        body: {},
      });
      assert.equal(payDenied.status, 403);

      const paid = await req(`/api/expense-claims/${claimId}/pay`, {
        method: 'POST',
        token: companyA.token,
        body: { comment: 'Paid via bank transfer' },
      });
      assert.equal(paid.status, 200, JSON.stringify(paid.data));
      assert.equal(paid.data.paymentStatus, 'Paid');
      assert.equal(paid.data.status, 'Paid');

      const byEmployee = await req('/api/expense-reports?groupBy=employee', { token: companyA.token });
      assert.equal(byEmployee.status, 200);
      const employeeRow = byEmployee.data.rows.find(
        (row: Record<string, unknown>) => row.name === 'ent alpha employee'
      );
      assert.ok(employeeRow, JSON.stringify(byEmployee.data.rows));
      assert.equal(employeeRow.totalAmount, 37.75);
      assert.equal(byEmployee.data.totals.totalAmount, 37.75);

      const byDepartment = await req('/api/expense-reports?groupBy=department', { token: companyA.token });
      assert.equal(byDepartment.status, 200);
      assert.equal(byDepartment.data.rows[0].totalAmount, 37.75);
    });

    await test('5. Strict tenant isolation across policies, shifts, leave, expenses, and ledger', async () => {
      const policiesB = await req('/api/leave-policies', { token: companyB.token });
      assert.equal(policiesB.status, 200);
      assert.equal(policiesB.data.policies.length, 0);

      const policiesA = await req('/api/leave-policies', { token: companyA.token });
      assert.equal(policiesA.data.policies.length, 2);

      const claimsB = await req('/api/expense-claims', { token: companyB.token });
      assert.ok(!claimsB.data.claims.some((row: Record<string, unknown>) => row.claim_id === claimId));

      const crossClaim = await req(`/api/expense-claims/${claimId}`, { token: companyB.token });
      assert.equal(crossClaim.status, 403);
      assert.equal(crossClaim.data.code, 'CROSS_TENANT_FORBIDDEN');

      const crossShiftAction = await req(`/api/shift-change-requests/${requestId}/action`, {
        method: 'POST',
        token: companyB.token,
        body: { decision: 'approve' },
      });
      assert.equal(crossShiftAction.status, 403);
      assert.equal(crossShiftAction.data.code, 'CROSS_TENANT_FORBIDDEN');

      const crossShiftDetail = await req(`/api/shift-change-requests/${requestId}`, { token: companyB.token });
      assert.equal(crossShiftDetail.status, 403);
      assert.equal(crossShiftDetail.data.code, 'CROSS_TENANT_FORBIDDEN');

      const crossPolicyAccrue = await req(`/api/leave-policies/${casualPolicyId}/accrue`, {
        method: 'POST',
        token: companyB.token,
        body: { period: '2026-06' },
      });
      assert.equal(crossPolicyAccrue.status, 403);
      assert.equal(crossPolicyAccrue.data.code, 'CROSS_TENANT_FORBIDDEN');

      const crossLeaveOverview = await req(`/api/leave-overview?employeeId=${employeeA.employeeRecordId}`, {
        token: employeeBToken,
      });
      assert.equal(crossLeaveOverview.status, 403);
      assert.equal(crossLeaveOverview.data.code, 'CROSS_TENANT_FORBIDDEN');

      const crossLeaveAction = await req(`/api/leaves/${leaveId}/action`, {
        method: 'POST',
        token: companyB.token,
        body: { decision: 'approve' },
      });
      assert.equal(crossLeaveAction.status, 403);
      assert.equal(crossLeaveAction.data.code, 'CROSS_TENANT_FORBIDDEN');

      const crossShiftReference = await req('/api/shift-change-requests', {
        method: 'POST',
        token: employeeBToken,
        body: {
          requestedShiftId: eveningShiftId,
          startDate: addDays(today, 10),
          endDate: addDays(today, 11),
          reason: 'Cross-tenant attempt',
        },
      });
      assert.equal(crossShiftReference.status, 403);
      assert.equal(crossShiftReference.data.code, 'CROSS_TENANT_FORBIDDEN');

      const crossEmployeePatch = await req(`/api/employees/${employeeA.employeeRecordId}`, {
        method: 'PATCH',
        token: companyB.token,
        body: { designation: 'Compromised' },
      });
      assert.equal(crossEmployeePatch.status, 403);
      assert.equal(crossEmployeePatch.data.code, 'CROSS_TENANT_FORBIDDEN');

      const ownOverviewB = await req('/api/leave-overview', { token: employeeBToken });
      assert.equal(ownOverviewB.status, 200);
      assert.ok(ownOverviewB.data.ledger.every((row: Record<string, unknown>) => row.company_id === companyB.companyId));
    });

    await test('8. Shift change submission rejects missing employee context explicitly', async () => {
      const userId = 'user_alpha_no_employee';
      const username = 'ent_alpha_no_employee';
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users
          (user_id, username, password_hash, email, mobile, full_name, company_id, role_id, account_status, must_change_password, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?)`
      ).run(
        userId,
        username,
        bcrypt.hashSync('Password@123', 10),
        `${username}@example.test`,
        '+1 555-0199',
        'No Employee Context',
        companyA.companyId,
        'role_employee',
        now
      );
      db.prepare('INSERT INTO login_identifiers (identifier, user_id, kind, created_at) VALUES (?, ?, ?, ?)').run(
        username,
        userId,
        'username',
        now
      );
      const token = await login(username);
      const response = await req('/api/shift-change-requests', {
        method: 'POST',
        token,
        body: {
          requestedShiftId: eveningShiftId,
          startDate: addDays(today, 40),
          endDate: addDays(today, 41),
          reason: 'Should not submit without employee record',
        },
      });
      assert.equal(response.status, 400, JSON.stringify(response.data));
      assert.equal(response.data.error, 'Employee context is required for this module.');
      assert.equal(response.data.code, 'EMPLOYEE_CONTEXT_REQUIRED');
    });

    console.log(`\nALL ${passed} ENTERPRISE INTEGRATION TESTS PASSED SUCCESSFULLY.`);
  } finally {
    server.close();
    await db.close();
  }
}

runTests().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
