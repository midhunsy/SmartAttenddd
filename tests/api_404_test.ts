import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { ServerDatabase } from '../server/postgres.ts';
import { createExpressApp } from '../server.ts';

const sessionRow = {
  session_id: 'session-test',
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  user_id: 'user-test',
  username: 'api_404_test',
  full_name: 'API 404 Test',
  email: 'api-404@example.test',
  company_id: 'company-test',
  account_status: 'active',
  must_change_password: 0,
  role_name: 'Employee',
  company_name: 'Test Company',
  company_status: 'active',
  employee_record_id: 'employee-test',
  employee_id: 'EMP-TEST',
  employment_status: 'active',
};

const db: ServerDatabase = {
  prepare(sql: string) {
    if (sql.includes('FROM sessions')) {
      return {
        get: () => sessionRow,
        all: () => [],
        run: () => ({ changes: 0, rowCount: 0 }),
      };
    }
    throw new Error(`Unexpected query in API 404 test: ${sql}`);
  },
  exec() {},
  close: async () => {},
  schemaName: null,
};

async function runTests() {
  const app = createExpressApp(db);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(`${baseUrl}/api/shift-change-requests-enterprise-missing`, {
        method,
        headers: { Authorization: 'Bearer test-token' },
      });
      assert.equal(response.status, 404, `${method} unknown API route status`);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(await response.json(), { error: 'API endpoint not found.' });
      console.log(`PASS: ${method} unknown API route returns JSON 404`);
    }
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
