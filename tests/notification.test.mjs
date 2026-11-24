import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createPayload, sendNotification } from '../actions/publish-envelope/notification.mjs';

// All identities, digests, URLs and credentials here are explicit test fixtures.
const token = 'test-fixture-token-'.repeat(3);
const env = () => ({
  PUBLISHED_TAGS: 'ghcr.io/example/services:42\nghcr.io/example/services:latest\nghcr.io/example/services:sha-abcdef0',
  PUBLISHED_DIGEST: `sha256:${'a'.repeat(64)}`, APP_VERSION: '42',
  GITHUB_REPOSITORY: 'Example/services', GITHUB_SHA: 'abcdef01'.repeat(5),
  GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1',
});
const publishedAt = '2026-11-09T18:00:00.000Z';
const payload = () => createPayload(env(), publishedAt);
async function server(t, handler) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return `http://127.0.0.1:${instance.address().port}/api/images/published`;
}
const localTransport = (url, options) => {
  const local = new URL(url); local.protocol = 'http:';
  return fetch(local, options);
};

test('rejects malformed source metadata without repairing it', () => {
  const invalid = {
    PUBLISHED_TAGS: ['', 'ghcr.io/example/services:latest\nghcr.io/other/services:42', 'ghcr.io/example/services:bad/tag', 'ghcr.io/example/services:latest\n', 'ghcr.io/example/services:latest\nghcr.io/example/services:latest', 'ghcr.io/Example/services:latest'],
    PUBLISHED_DIGEST: ['sha256:abc', `sha256:${'A'.repeat(64)}`, ' sha256:' + 'a'.repeat(64)],
    APP_VERSION: ['0', '1.2.3', ' 42', '01'], GITHUB_SHA: ['abc', 'A'.repeat(40)],
    GITHUB_REPOSITORY: ['example', 'owner/repo/extra', '../repo'],
    GITHUB_REF: ['', 'main', 'refs/heads/bad name', 'refs/heads/a..b', 'refs/heads/a@{b', 'refs/heads//main', 'refs/heads/main/', 'refs/heads/main.lock', 'refs/heads/.hidden'],
    GITHUB_RUN_ID: ['1x', '0', '01'], GITHUB_RUN_ATTEMPT: ['0', '1.5', '9007199254740992'],
  };
  for (const [key, values] of Object.entries(invalid)) {
    for (const value of [...values, undefined]) {
      assert.throws(() => createPayload({ ...env(), [key]: value }, publishedAt), undefined, key);
    }
  }
  for (const time of ['yesterday', '2026-02-30T00:00:00.000Z', '2026-11-09T18:00:00+00:00']) {
    assert.throws(() => createPayload(env(), time));
  }
});

test('supports an image name different from its GitHub source repository', () => {
  const custom = createPayload({ ...env(), GITHUB_REPOSITORY: 'Example/finance-typescript', PUBLISHED_TAGS: 'ghcr.io/example/finance:latest\nghcr.io/example/finance:42' }, publishedAt);
  assert.equal(custom.repository, 'ghcr.io/example/finance');
  assert.equal(custom.sourceRepository, 'Example/finance-typescript');
  assert.deepEqual(custom.tags, ['latest', '42']);
});

test('Script-produced tags preserve latest omission on old publication reruns', () => {
  for (const tags of [['42', 'latest'], ['42']]) {
    const captured = createPayload({
      ...env(), GITHUB_REPOSITORY: 'everyonesoftware/tasks',
      PUBLISHED_TAGS: tags.map(tag => `ghcr.io/everyonesoftware/tasks:${tag}`).join('\n'),
    }, publishedAt);
    assert.equal(captured.repository, 'ghcr.io/everyonesoftware/tasks');
    assert.equal(captured.version, '42');
    assert.deepEqual(captured.tags, tags);
  }
  // Unknown shell output still fails closed at capture time, before sending.
  for (const references of ['docker.io/everyonesoftware/tasks:42', 'ghcr.io/everyonesoftware/tasks:42\nghcr.io/other/image:latest']) {
    assert.throws(() => createPayload({ ...env(), PUBLISHED_TAGS: references }, publishedAt));
  }
});

test('publisher capture accepts the exact GHCR repositories supported by managed keys', () => {
  for (const repository of ['ghcr.io/example/my__app', 'ghcr.io/example/my--app', 'ghcr.io/example/nested/app']) {
    assert.equal(createPayload({ ...env(), PUBLISHED_TAGS: `${repository}:latest` }, publishedAt).repository, repository);
  }
  for (const repository of ['ghcr.io/example/bad___app', 'ghcr.io/example/' + 'a'.repeat(256)]) {
    assert.throws(() => createPayload({ ...env(), PUBLISHED_TAGS: `${repository}:latest` }, publishedAt));
  }
  assert.throws(() => createPayload({ ...env(), PUBLISHED_TAGS: Array.from({ length: 65 }, (_, i) => `ghcr.io/example/app:tag-${i}`).join('\n') }, publishedAt));
});

test('POSTs bearer-authenticated JSON and acknowledges accepted, duplicate and stale', async t => {
  for (const result of ['accepted', 'duplicate', 'stale']) {
    let received;
    const endpoint = await server(t, async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      received = { method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result }));
    });
    assert.equal(await sendNotification({ endpoint: endpoint.replace('http:', 'https:'), token, payload: payload(), transport: localTransport }), result);
    assert.deepEqual(received, { method: 'POST', url: '/api/images/published', auth: `Bearer ${token}`, type: 'application/json', body: JSON.stringify(payload()) });
  }
});

test('fails closed on invalid endpoint, credential and artifact before transport', async () => {
  let requests = 0;
  const transport = () => { requests++; throw new Error('must not send'); };
  const options = { endpoint: 'https://fixture.invalid/api/images/published', token, payload: payload(), transport };
  for (const endpoint of ['http://localhost/api/images/published', 'https://user:pass@fixture.invalid/api/images/published', 'https://fixture.invalid/wrong', 'https://fixture.invalid/api/images/published?token=secret', 'https://fixture.invalid/api/images/published#x', ' https://fixture.invalid/api/images/published']) {
    await assert.rejects(sendNotification({ ...options, endpoint }), /Invalid endpoint/);
  }
  for (const invalidToken of ['', 'x'.repeat(31), token + '\n', ' '.repeat(40), undefined]) {
    await assert.rejects(sendNotification({ ...options, token: invalidToken }), /Invalid token/);
  }
  for (const bad of [null, { ...payload(), extra: true }, { ...payload(), schemaVersion: '1' }, { ...payload(), tags: 'latest' }, { ...payload(), tags: ['ghcr.io/example/services:latest'] }, { ...payload(), runAttempt: '1' }, { ...payload(), runUrl: 'https://evil.invalid/' }, { ...payload(), repository: 'ghcr.io/example/services:latest' }]) {
    await assert.rejects(sendNotification({ ...options, payload: bad }), /Invalid/);
  }
  assert.equal(requests, 0);
});

test('retries only transient HTTP responses with the exact captured body', async t => {
  for (const status of [408, 429, 500, 503, 599]) {
    const bodies = [];
    const endpoint = await server(t, async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      bodies.push(body);
      res.statusCode = bodies.length === 1 ? status : 200;
      res.end(JSON.stringify({ result: 'duplicate' }));
    });
    const original = payload();
    assert.equal(await sendNotification({ endpoint: endpoint.replace('http:', 'https:'), token, payload: original, transport: localTransport, baseDelayMs: 1 }), 'duplicate');
    assert.deepEqual(bodies, [JSON.stringify(original), JSON.stringify(original)]);
  }
});

test('never retries permanent HTTP or malformed acknowledgements and never follows redirects', async t => {
  for (const [status, body] of [[400, '{"result":"accepted"}'], [401, 'secret'], [403, '{}'], [404, '{}'], [409, '{}'], [302, '{}'], [200, 'not JSON'], [200, '{"result":"unknown"}'], [204, '']]) {
    let requests = 0;
    const endpoint = await server(t, (req, res) => {
      requests++; res.statusCode = status; res.setHeader('Location', '/stolen'); res.end(body);
    });
    await assert.rejects(sendNotification({ endpoint: endpoint.replace('http:', 'https:'), token, payload: payload(), transport: localTransport, baseDelayMs: 1 }), /Notification/);
    assert.equal(requests, 1, String(status));
  }
});

test('bounds retries, times out stalled responses and sanitizes failures', async t => {
  let requests = 0;
  const endpoint = await server(t, (req, res) => { requests++; res.statusCode = 503; res.end(token); });
  const options = { endpoint: endpoint.replace('http:', 'https:'), token, payload: payload(), transport: localTransport, maxAttempts: 3, timeoutMs: 30, baseDelayMs: 1 };
  await assert.rejects(sendNotification(options), /Notification failed after 3 attempts/);
  assert.equal(requests, 3);
  let hanging = 0;
  const stalled = await server(t, () => { hanging++; });
  await assert.rejects(sendNotification({ ...options, endpoint: stalled.replace('http:', 'https:'), maxAttempts: 2 }), /Notification failed after 2 attempts/);
  assert.equal(hanging, 2);
  let failures = 0;
  await assert.rejects(sendNotification({ ...options, transport: async () => { failures++; throw new TypeError(`fetch failed: ${token}`, { cause: { code: 'ECONNRESET' } }); } }), error => !error.message.includes(token) && /Notification failed/.test(error.message));
  assert.equal(failures, 3);
});

test('does not retry permanent TLS, DNS or arbitrary transport errors', async () => {
  for (const code of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ENOTFOUND', undefined]) {
    let attempts = 0;
    await assert.rejects(sendNotification({ endpoint: 'https://fixture.invalid/api/images/published', token, payload: payload(), baseDelayMs: 1,
      transport: async () => { attempts++; throw new TypeError('fixture transport failure', { cause: { code } }); },
    }), /Notification/);
    assert.equal(attempts, 1, String(code));
  }
});

test('retries a real connection reset and bounds retry options', async t => {
  let requests = 0;
  const endpoint = await server(t, (req, res) => {
    requests++; if (requests === 1) req.socket.destroy(); else res.end('{"result":"accepted"}');
  });
  const options = { endpoint: endpoint.replace('http:', 'https:'), token, payload: payload(), transport: localTransport, baseDelayMs: 1 };
  assert.equal(await sendNotification(options), 'accepted');
  assert.equal(requests, 2);
  for (const bad of [{ maxAttempts: 0 }, { maxAttempts: 10 }, { maxAttempts: 1.5 }, { timeoutMs: 0 }, { timeoutMs: Infinity }, { baseDelayMs: -1 }, { baseDelayMs: 100000 }]) {
    await assert.rejects(sendNotification({ ...options, ...bad }), /Invalid retry options/);
  }
});

test('captures actual published bare tags and root digest in the contract', () => {
  assert.deepEqual(payload(), {
    schemaVersion: 1, repository: 'ghcr.io/example/services',
    tags: ['42', 'latest', 'sha-abcdef0'], digest: env().PUBLISHED_DIGEST,
    version: '42', sourceRepository: 'Example/services', commit: env().GITHUB_SHA,
    ref: 'refs/heads/main', runId: '12345', runAttempt: 1,
    runUrl: 'https://github.com/Example/services/actions/runs/12345', publishedAt,
  });
});
