#!/usr/bin/env node
/**
 * Manual test script for Login, Registration, Forgot/Reset Password flow.
 * Run: node scripts/test-auth-flow.mjs
 * Requires: Backend running on http://localhost:3000
 */
const BASE = 'http://localhost:3000/v1';

const testEmail = `test-auth-${Date.now()}@example.com`;
const testPassword = 'TestPass123';
let resetToken = null;

async function request(method, path, body = null, opts = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
    credentials: 'include',
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, ok: res.ok };
}

async function run() {
  console.log('=== Auth Flow Test ===\n');

  // 1. Register
  console.log('1. Register (POST /auth/register)');
  const regRes = await request('POST', '/auth/register', {
    name: 'Test User',
    email: testEmail,
    password: testPassword,
  });
  if (regRes.status === 201 && regRes.data?.user) {
    console.log('   ✓ Registration OK - user:', regRes.data.user.email);
  } else {
    console.log('   ✗ Registration failed:', regRes.status, regRes.data);
    process.exit(1);
  }

  // 2. Login
  console.log('\n2. Login (POST /auth/login)');
  const loginRes = await request('POST', '/auth/login', {
    email: testEmail,
    password: testPassword,
  });
  if (loginRes.ok && (loginRes.data?.user || loginRes.data?.tokens)) {
    console.log('   ✓ Login OK');
  } else {
    console.log('   ✗ Login failed:', loginRes.status, loginRes.data);
  }

  // 3. Forgot password (uses nodemailer - may fail if SMTP not configured)
  console.log('\n3. Forgot Password (POST /auth/forgot-password)');
  const forgotRes = await request('POST', '/auth/forgot-password', {
    email: testEmail,
  });
  if (forgotRes.status === 204) {
    console.log('   ✓ Forgot password OK (204) - email sent (or would be if SMTP configured)');
  } else if (forgotRes.status === 404) {
    console.log('   ✗ Email not found (404)');
  } else {
    console.log('   Response:', forgotRes.status, forgotRes.data);
  }

  // 4. Reset password - need a valid token. We can't get it from email in script.
  // So we test with invalid token (expect 401)
  console.log('\n4. Reset Password (POST /auth/reset-password?token=invalid)');
  const resetRes = await request('POST', '/auth/reset-password?token=invalid', {
    password: 'NewPass456',
  });
  if (resetRes.status === 401) {
    console.log('   ✓ Invalid token correctly rejected (401)');
  } else {
    console.log('   Response:', resetRes.status, resetRes.data);
  }

  // 5. Try login with wrong password
  console.log('\n5. Login with wrong password');
  const wrongRes = await request('POST', '/auth/login', {
    email: testEmail,
    password: 'WrongPass123',
  });
  if (wrongRes.status === 401) {
    console.log('   ✓ Wrong password correctly rejected (401)');
  } else {
    console.log('   ✗ Expected 401:', wrongRes.status);
  }

  // 6. Duplicate registration
  console.log('\n6. Duplicate registration (same email)');
  const dupRes = await request('POST', '/auth/register', {
    name: 'Other',
    email: testEmail,
    password: 'OtherPass1',
  });
  if (dupRes.status === 400) {
    console.log('   ✓ Duplicate email correctly rejected (400)');
  } else {
    console.log('   Response:', dupRes.status, dupRes.data);
  }

  console.log('\n=== Backend auth flow test complete ===');
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
