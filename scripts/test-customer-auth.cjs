// Isolated route regression tests: real password hashing, no network or live DB writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const { test } = require('node:test');

process.env.AUTH_SECRET = 'isolated-auth-regression-test-secret-only';
const users = new Map();
const rates = new Map();
const tokens = new Map();
let registrationEnabled = true;
let snapshot;
let releases = 0;
const connection = {
  async beginTransaction() { snapshot = structuredClone({ users, rates, tokens }); },
  async commit() { snapshot = null; },
  async rollback() {
    if (snapshot) {
      for (const [target, source] of [[users, snapshot.users], [rates, snapshot.rates], [tokens, snapshot.tokens]]) {
        target.clear(); for (const [key, value] of source) target.set(key, value);
      }
      snapshot = null;
    }
  },
  release() { releases++; },
  async execute(sql, args = []) {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('INSERT INTO live_test_login_attempts')) {
      const key = args.join(':'); if (!rates.has(key)) rates.set(key, { failed_attempts: 0, is_blocked: 0 });
      return [{}];
    }
    if (q.startsWith('SELECT failed_attempts')) return [[rates.get(args.join(':'))]];
    if (q.startsWith('UPDATE live_test_login_attempts')) {
      const rate = rates.get(args.join(':')); rate.failed_attempts++; rate.is_blocked = Number(rate.failed_attempts >= 5); return [{}];
    }
    if (q.startsWith('DELETE FROM live_test_login_attempts')) { rates.delete(args.join(':')); return [{}]; }
    if (q.includes(' AS has_password FROM users')) {
      const user = users.get(args[0]); return [user ? [{ has_password: Number(Boolean(user.password_hash)) }] : []];
    }
    if (q.startsWith('SELECT') && q.includes('FROM users WHERE email')) return [users.has(args[0]) ? [users.get(args[0])] : []];
    if (q.includes('FROM site_settings')) return [[{ setting_value: registrationEnabled ? 'true' : 'false' }]];
    if (q.startsWith('INSERT INTO users')) {
      const [id, email, password_hash, display_name] = args;
      users.set(email, { id, email, password_hash, display_name, status: 'active', is_test_account: 0, email_verified_at: null });
      assert(!q.includes('email_verified_at'), 'Password signup must not verify email'); return [{}];
    }
    if (q.startsWith('UPDATE users')) {
      const user = [...users.values()].find(u => u.id === args[0]);
      if (q.includes('email_verified_at')) user.email_verified_at = new Date();
      return [{}];
    }
    if (q.includes('FROM auth_tokens')) {
      const token = tokens.get(args[0]); return [token && !token.used && !token.expired ? [token] : []];
    }
    if (q.startsWith('UPDATE auth_tokens SET attempts')) { [...tokens.values()].find(t => t.id === args[0]).attempts++; return [{}]; }
    if (q.startsWith('UPDATE auth_tokens SET used_at')) { [...tokens.values()].find(t => t.id === args[0]).used = true; return [{}]; }
    if (q.startsWith('UPDATE auth_tokens SET user_id')) return [{}];
    throw Error('Unexpected SQL in test: ' + q);
  },
};
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const localRequire = name => name === '@/lib/mysql' ? { getPool: () => ({ ...connection, getConnection: async () => connection }) }
    : name.startsWith('@/') ? load('src/' + name.slice(2) + '.ts') : require(name);
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: file })(localRequire, module, module.exports);
  return module.exports;
}
const passwordRoute = load('src/app/api/auth/password/route.ts');
const optionsRoute = load('src/app/api/auth/email-options/route.ts');
const otpRoute = load('src/app/api/auth/verify-otp/route.ts');
const session = load('src/lib/session.ts');
async function call(route, body) {
  const response = await route.POST(new NextRequest('http://localhost/api/auth/test', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
  return { response, body: await response.json() };
}
const email = 'customer@example.com';
test('customer password and OTP regression scenarios', async t => {
  await t.test('email lookup does not create an account or send OTP', async () => {
    const r = await call(optionsRoute, { email }); assert.deepEqual(r.body, { exists: false, hasPassword: false }); assert.equal(users.size, 0); assert.equal(tokens.size, 0);
  });
  for (const password of ['12345', '1234567890123']) await t.test('reject password length ' + password.length, async () => {
    assert.equal((await call(passwordRoute, { email, password, action: 'register' })).response.status, 400);
  });
  await t.test('six-character password creates account, hashes and logs in without OTP', async () => {
    const r = await call(passwordRoute, { email: ' CUSTOMER@EXAMPLE.COM ', password: '123456', action: 'register' });
    assert.equal(r.response.status, 200); assert.equal(r.body.isNewUser, true); assert(r.response.cookies.get('sportrz_session'));
    assert.notEqual(users.get(email).password_hash, '123456'); assert(await session.verifyPassword('123456', users.get(email).password_hash));
    assert.equal(tokens.size, 0); assert.equal(users.get(email).email_verified_at, null); assert.equal(r.body.password_hash, undefined);
  });
  await t.test('lookup recognizes saved password', async () => {
    assert.deepEqual((await call(optionsRoute, { email })).body, { exists: true, hasPassword: true });
  });
  await t.test('register cannot overwrite an existing password', async () => {
    const old = users.get(email).password_hash;
    assert.equal((await call(passwordRoute, { email, password: 'hijack', action: 'register' })).response.status, 409);
    assert.equal(users.get(email).password_hash, old);
  });
  await t.test('saved password logs in and wrong password does not', async () => {
    assert.equal((await call(passwordRoute, { email, password: 'wrong!', action: 'login' })).response.status, 401);
    const r = await call(passwordRoute, { email, password: '123456', action: 'login' }); assert.equal(r.response.status, 200); assert(r.response.cookies.get('sportrz_session')); assert.equal(rates.size, 0);
  });
  await t.test('suspended user is blocked', async () => {
    users.get(email).status = 'suspended'; assert.equal((await call(passwordRoute, { email, password: '123456', action: 'login' })).response.status, 403); users.get(email).status = 'active';
  });
  await t.test('registration setting and twelve-character password', async () => {
    registrationEnabled = false;
    assert.equal((await call(passwordRoute, { email: 'new@example.com', password: '123456789012', action: 'register' })).response.status, 403);
    registrationEnabled = true;
    assert.equal((await call(passwordRoute, { email: 'new@example.com', password: '123456789012', action: 'register' })).response.status, 200);
  });
  await t.test('OTP-only account cannot have its password set anonymously', async () => {
    users.set('otp@example.com', { id: 'otp-user', password_hash: null, status: 'active', is_test_account: 0 });
    assert.deepEqual((await call(optionsRoute, { email: 'otp@example.com' })).body, { exists: true, hasPassword: false });
    assert.equal((await call(passwordRoute, { email: 'otp@example.com', password: '123456', action: 'register' })).response.status, 409);
    assert.equal((await call(passwordRoute, { email: 'otp@example.com', password: '123456', action: 'login' })).response.status, 401);
  });
  await t.test('five password failures block the next attempt', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await call(passwordRoute, { email, password: 'wrong!', action: 'login' })).response.status, 401);
    assert.equal((await call(passwordRoute, { email, password: '123456', action: 'login' })).response.status, 429);
  });
  await t.test('OTP works despite password block, verifies email and preserves password', async () => {
    const hash = users.get(email).password_hash;
    tokens.set(email, { id: 1, attempts: 0, token_hash: session.hashOneTimeToken(`1:${email}:654321`) });
    const r = await call(otpRoute, { email, otp: '654321' }); assert.equal(r.response.status, 200); assert(r.response.cookies.get('sportrz_session'));
    assert.equal(users.get(email).password_hash, hash); assert(users.get(email).email_verified_at);
    assert.equal((await call(otpRoute, { email, otp: '654321' })).response.status, 400);
  });
  await t.test('disabled QA identities cannot use customer password endpoint', async () => {
    users.get(email).is_test_account = 1; rates.clear(); process.env.ENABLE_DEV_TEST_ACCOUNTS = 'false';
    assert.equal((await call(passwordRoute, { email, password: '123456', action: 'login' })).response.status, 403);
  });
  assert.equal(snapshot, null); assert(releases > 10);
});

test('login screen email, method choice, password and OTP interactions', async t => {
  const React = require('react');
  const states = [];
  let cursor = 0;
  let calls = [];
  let lookup = { exists: false, hasPassword: false };
  const mockAuth = {
    currentUser: null, loading: false,
    authenticateWithPassword: async (...args) => { calls.push(['password', ...args]); },
    requestLoginOtp: async email => { calls.push(['otp', email]); return { message: 'Sent', retryAfterSeconds: 60 }; },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return { ok: true, json: async () => lookup };
  };
  try {
    const file = 'src/components/auth/EmailOtpAuth.tsx';
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
    const module = { exports: {} };
    const req = name => name === 'react' ? { ...React, useEffect() {}, useState(initial) {
      const i = cursor++; if (!(i in states)) states[i] = initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    } } : name === 'next/navigation' ? { useRouter: () => ({ refresh() {}, replace() {} }) }
      : name === '@/contexts/AuthContext' ? { useAuth: () => mockAuth } : require(name);
    vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: file })(req, module, module.exports);
    function tree() { cursor = 0; return module.exports.default(); }
    function all(node, predicate) {
      if (node == null || typeof node !== 'object') return [];
      if (Array.isArray(node)) return node.flatMap(n => all(n, predicate));
      return [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)];
    }
    function text(node) {
      if (node == null) return ''; if (Array.isArray(node)) return node.map(text).join('');
      return typeof node === 'object' ? text(node.props?.children) : String(node);
    }
    function button(label) { const b = all(tree(), n => n.type === 'button' && text(n).includes(label))[0]; assert(b, 'Missing button: ' + label); return b; }
    function input(id, value) { const i = all(tree(), n => n.props?.id === id)[0]; assert(i, 'Missing input ' + id); i.props.onChange({ target: { value } }); }
    async function submit() { await all(tree(), n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }); }
    await t.test('email Continue checks account without sending OTP', async () => {
      input('auth-email', ' New@Example.com '); await submit();
      assert.equal(calls.length, 1); assert.equal(calls[0][0], '/api/auth/email-options');
      assert.equal(calls[0][1].email, 'new@example.com'); button('Create password'); button('Login with OTP');
    });
    await t.test('new user chooses password, signs up, and never requests OTP', async () => {
      button('Create password').props.onClick(); input('customer-password', 'abcdef'); await submit();
      assert(calls.some(c => c[0] === 'password' && c[1] === 'new@example.com' && c[2] === 'abcdef' && c[3] === 'register'));
      assert(!calls.some(c => c[0] === 'otp'));
    });
    await t.test('returning user chooses saved password', async () => {
      button('Change email').props.onClick(); lookup = { exists: true, hasPassword: true };
      input('auth-email', 'existing@example.com'); await submit();
      button('Login with password').props.onClick(); input('customer-password', 'abcdef'); await submit();
      assert(calls.some(c => c[0] === 'password' && c[3] === 'login'));
    });
    await t.test('forgot password explicitly requests OTP and shows verification', async () => {
      await button('Forgot password? Login with OTP').props.onClick();
      assert(calls.some(c => c[0] === 'otp' && c[1] === 'existing@example.com'));
      assert(all(tree(), n => n.props?.id === 'auth-otp').length);
    });
    await t.test('changing email clears password and OTP', async () => {
      input('auth-otp', '123456'); button('Change email').props.onClick();
      lookup = { exists: true, hasPassword: true }; input('auth-email', 'other@example.com'); await submit();
      button('Login with password').props.onClick();
      assert.equal(all(tree(), n => n.props?.id === 'customer-password')[0].props.value, '');
    });
  } finally { global.fetch = originalFetch; }
});
