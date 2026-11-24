import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayload, validatePayload, sendNotification } from '../actions/publish-envelope/notification.mjs';

const payload = {
  schemaVersion: 1, repository: 'ghcr.io/example/app', tags: ['42'],
  digest: `sha256:${'a'.repeat(64)}`, version: '42', sourceRepository: 'example/app',
  commit: 'b'.repeat(40), ref: 'refs/heads/main', runId: '123', runAttempt: 1,
  runUrl: 'https://github.com/example/app/actions/runs/123', publishedAt: '2026-11-09T18:00:00.000Z',
};
const options = { endpoint: 'https://fixture.invalid/api/images/published', token: 'public-disposable-test-token-'.repeat(2), payload, baseDelayMs: 0 };

test('permanent rejection preserves only its HTTP status, never the response body', async () => {
  for (const status of [401, 403, 409]) {
    let requests = 0;
    await assert.rejects(sendNotification({ ...options, transport: async () => {
      requests++;
      return new Response('untrusted-provider-text private-token https://private.invalid/', { status });
    } }), error => error.message === `Notification rejected (HTTP ${status})`);
    assert.equal(requests, 1);
  }
});

test('malformed acknowledgements remain distinct from HTTP rejection', async () => {
  await assert.rejects(sendNotification({ ...options, transport: async () => new Response('untrusted malformed body', { status: 200 }) }),
    error => error.message === 'Notification invalid acknowledgement (HTTP 200)');
});

test('HTTP-success response-body timeouts remain transient and bounded', async () => {
  let attempts = 0;
  const bodies = [];
  await assert.rejects(sendNotification({ ...options, maxAttempts: 3, timeoutMs: 5,
    transport: async (_endpoint, request) => {
      attempts++;
      bodies.push(request.body);
      return new Response(new ReadableStream({ start(controller) {
        request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true });
      } }), { status: 200 });
    },
  }), error => error.message === 'Notification failed after 3 attempts (last HTTP 200)');
  assert.equal(attempts, 3);
  assert.deepEqual(bodies, Array(3).fill(JSON.stringify(payload)));
});

test('transient body-read resets retry without leaking their exception text', async () => {
  let attempts = 0;
  assert.equal(await sendNotification({ ...options, transport: async () => {
    if (++attempts > 1) return new Response('{"result":"duplicate"}');
    return new Response(new ReadableStream({ start(controller) {
      controller.error(new TypeError('private transport failure', { cause: { code: 'ECONNRESET' } }));
    } }));
  } }), 'duplicate');
  assert.equal(attempts, 2);
});

test('transient exhaustion preserves the last HTTP status safely', async () => {
  await assert.rejects(sendNotification({ ...options, maxAttempts: 2, transport: async () => new Response('private provider body', { status: 503 }) }),
    error => error.message === 'Notification failed after 2 attempts (last HTTP 503)');
});

test('capture preserves the GitHub immutable repository ID as a decimal string', () => {
  const env = {
    PUBLISHED_TAGS: 'ghcr.io/example/app:42', PUBLISHED_DIGEST: payload.digest, APP_VERSION: '42',
    GITHUB_REPOSITORY: 'example/app', GITHUB_REPOSITORY_ID: '9007199254740993', GITHUB_SHA: payload.commit,
    SERVICES_PUBLISH_IDENTITY_VERSION: '1',
    GITHUB_REF: payload.ref, GITHUB_RUN_ID: payload.runId, GITHUB_RUN_ATTEMPT: '1',
  };
  const captured = createPayload(env, payload.publishedAt);
  assert.equal(captured.sourceRepositoryId, '9007199254740993');
  validatePayload(captured);
  assert.equal(Object.hasOwn(createPayload({ ...env, SERVICES_PUBLISH_IDENTITY_VERSION: undefined }, payload.publishedAt), 'sourceRepositoryId'), false);
  for (const id of ['', '01', '-1', '0', '1.0', ' 12', '9223372036854775808', 123, undefined]) {
    assert.throws(() => createPayload({ ...env, GITHUB_REPOSITORY_ID: id }, payload.publishedAt), /Invalid sourceRepositoryId/);
  }
  assert.throws(() => validatePayload({ ...payload, sourceRepositoryId: '01' }), /Invalid sourceRepositoryId/);
});
