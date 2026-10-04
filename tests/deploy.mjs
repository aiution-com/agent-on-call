// Guards for the deployment contract: the health endpoint a container
// orchestrator polls, and the proxy trust setting that decides whether the
// origin check sees the scheme the browser actually used.
//
// These are regression guards, not TDD steps — the behaviour is already
// correct under the default configuration. They exist so that changing
// TRUST_PROXY's default, or the origin check, fails loudly here instead of in
// a deployment behind a TLS-terminating proxy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { app } = require('../dist/index.js');
const { pool } = require('../dist/db.js');
const { parseTrustProxy } = require('../dist/config.js');

const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const host = `127.0.0.1:${server.address().port}`;

async function posted(origin, forwardedProto) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
      ...(forwardedProto ? { 'X-Forwarded-Proto': forwardedProto } : {}),
    },
    body: JSON.stringify({ email: 'nobody@example.test', password: 'not-the-password' }),
  });
  return response.status;
}

test('the deployment contract holds', async t => {
  await t.test('the health endpoint reports ready while the database answers', async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  await t.test('a trusted proxy scheme satisfies the origin check', async () => {
    // The test client connects over loopback, which the default TRUST_PROXY
    // trusts. A browser reaching a TLS proxy sends an https Origin, so the
    // check must compare against https — and it only can if the forwarded
    // scheme is believed. A 403 here is the deployment bug this guards against.
    const status = await posted(`https://${host}`, 'https');
    assert.notEqual(status, 403, 'the forwarded https scheme was not trusted, so the origin check rejected the request');
    assert.equal(status, 401, 'expected the origin check to pass and the login to fail on credentials');
  });

  await t.test('an untrusted or absent proxy scheme is not believed', async () => {
    // Same Origin, but nothing asserted the scheme was upgraded: req.protocol
    // stays http, so an https Origin no longer matches and the check refuses.
    const status = await posted(`https://${host}`, undefined);
    assert.equal(status, 403);
  });

  await t.test('a foreign origin is still refused', async () => {
    const status = await posted('https://attacker.example', 'https');
    assert.equal(status, 403);
  });

  await t.test('the origin check does not reject the plain http case it must allow', async () => {
    const status = await posted(base, undefined);
    assert.equal(status, 401, 'a same-origin request over plain http should pass the origin check');
  });
});

test('the help page is reachable and answers the questions that cause support tickets', async t => {
  // Reachable WITHOUT a session, deliberately: someone who has just been handed a
  // URL has no account yet, and that is exactly who needs this page.
  const response = await fetch(`${base}/help`);
  assert.equal(response.status, 200);
  const html = await response.text();

  await t.test('it renders without any session cookie', () => {
    assert.match(html, /How AgentOnCall works/);
  });

  // Each of these is a question a real user asks. If a rewrite drops one, the page
  // stops doing its job, which is not something the eye catches in review.
  await t.test('it explains the vocabulary', () => {
    for (const term of ['Workspace', 'Agent', 'Task', 'Approval', 'Incident', 'Halted']) {
      assert.ok(html.includes(term), `glossary is missing "${term}"`);
    }
  });

  await t.test('it is honest about what the product cannot do', () => {
    assert.match(html, /I forgot my password/i);
    assert.match(html, /Can I invite a colleague/i);
    assert.match(html, /cooperative/i);
  });

  await t.test('it obeys the CSP: no inline styles or scripts', () => {
    // style-src is 'self' with no unsafe-inline, so a style attribute would be
    // silently dropped by the browser and the page would look broken with no error.
    assert.equal(/style\s*=/.test(html), false, 'help.html contains an inline style, which the CSP blocks');
    assert.equal(/<script/i.test(html), false, 'help.html contains a script tag; the page should need none');
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'help.html contains an inline event handler, which the CSP blocks');
  });
});

test('TRUST_PROXY parses the values a deployment would set', () => {
  // Default: the laptop topology, where cloudflared connects over loopback.
  assert.equal(parseTrustProxy(undefined), 'loopback');
  assert.equal(parseTrustProxy(''), 'loopback');
  assert.equal(parseTrustProxy('   '), 'loopback');
  // Express's own vocabulary.
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('false'), false);
  // A hop count, which is what a proxy in its own container needs.
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('0'), 0);
  // A list of addresses or subnets.
  assert.deepEqual(parseTrustProxy('loopback,172.16.0.0/12'), ['loopback', '172.16.0.0/12']);
  assert.deepEqual(parseTrustProxy(' loopback , 10.0.0.0/8 '), ['loopback', '10.0.0.0/8']);
  // A single subnet, passed through.
  assert.equal(parseTrustProxy('172.16.0.0/12'), '172.16.0.0/12');
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});
