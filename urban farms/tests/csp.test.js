import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = 'http://127.0.0.1:3000';

test('login page is served without a restrictive CSP', async () => {
  const response = await fetch(`${baseUrl}/login.html`);
  const csp = response.headers.get('content-security-policy');

  assert.equal(response.status, 200);
  assert.equal(csp, null);
});

test('internal data and source files are not publicly served', async () => {
  const privatePaths = ['/data/customers.json', '/data/orders.json', '/server.js', '/package.json', '/.env'];

  for (const path of privatePaths) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must not be public`);
  }
});
