import assert from 'node:assert/strict';
import { calculateAccrualDays, type LeavePolicyRow } from '../server/services/enterpriseLeave.ts';

function policy(overrides: Partial<LeavePolicyRow> = {}): LeavePolicyRow {
  return {
    policy_id: 'pol_test',
    company_id: 'CMP-TEST',
    leave_type: 'Casual Leave',
    accrual_method: 'Monthly',
    monthly_entitlement: 1.5,
    annual_entitlement: 18,
    credit_day: 1,
    accrual_timing: 'Start of Month',
    eligibility: 'All Employees',
    probation_months: 0,
    prorate_by_joining_date: 1,
    carry_forward: 0,
    carry_forward_cap: 0,
    expiry_months: 0,
    max_balance: 0,
    fractional_support: 1,
    is_active: 1,
    effective_from: '2026-01-01',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function run(name: string, fn: () => void): void {
  fn();
  console.log(`PASS: ${name}`);
}

run('monthly accrual keeps fractional entitlement', () => {
  assert.equal(calculateAccrualDays(policy(), '2024-01-01', '2026-11'), 1.5);
});

run('monthly accrual prorates from joining day', () => {
  assert.equal(calculateAccrualDays(policy(), '2026-11-16', '2026-11'), 0.75);
});

run('annual allocation credits full entitlement without proration', () => {
  assert.equal(
    calculateAccrualDays(policy({ accrual_method: 'Annual', prorate_by_joining_date: 0 }), '2024-01-01', '2026-01'),
    18
  );
});

run('annual allocation prorates from joining month', () => {
  assert.equal(calculateAccrualDays(policy({ accrual_method: 'Annual' }), '2026-07-10', '2026-01'), 9);
});

run('non-fractional policies floor accrued days', () => {
  assert.equal(calculateAccrualDays(policy({ fractional_support: 0 }), '2024-01-01', '2026-11'), 1);
});

run('probation eligibility blocks early accrual', () => {
  assert.equal(calculateAccrualDays(policy({ probation_months: 3 }), '2026-09-01', '2026-11'), 0);
});

console.log('Enterprise leave calculation unit tests passed.');
