import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalInitialAccount } from '../src/main/local-initial-account.ts';

test('first account validates identity and password without accepting extra authority fields', () => {
  assert.deepEqual(parseLocalInitialAccount({ account: '  Customer_01  ', password: 'customer-secret-123' }),
    { account: 'customer_01', password: 'customer-secret-123' });
  for (const input of [null, {}, { account: '../bad', password: 'customer-secret-123' },
    { account: 'customer', password: 'short' }, { account: 'customer', password: 'x'.repeat(129) },
    { account: 'customer', password: 'customer-secret-123', role: 'super_admin' }])
    assert.throws(() => parseLocalInitialAccount(input), /local_initial_account_invalid/);
});
