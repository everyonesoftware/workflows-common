import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = join(root, 'actions/publish-envelope/action.mjs');
const context = {
  GITHUB_REPOSITORY: 'Example/workflow-caller', GITHUB_REPOSITORY_ID: '9007199254740999',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1',
};
const artifact = 'services-publish-12345-1';
const tags = 'ghcr.io/example/app:42\nghcr.io/example/app:latest';
const digest = 'sha256:' + 'b'.repeat(64);

async function harness(t) {
  const temp = await mkdtemp(join(root, '.test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const outputPath = join(temp, 'output');
  const env = { ...context, RUNNER_TEMP: temp, GITHUB_OUTPUT: outputPath };
  const invoke = async (mode, fields = {}) => {
    await writeFile(outputPath, '');
    const { status, stderr, stdout } = spawnSync(process.execPath, [entry], {
      env: { ...env, 'INPUT_MODE': mode, ...fields }, encoding: 'utf8',
    });
    const output = Object.fromEntries((await readFile(outputPath, 'utf8')).trimEnd().split('\n')
      .filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    return { status, stderr, stdout, output };
  };
  const capture = (overrides) => invoke('capture', { INPUT_DIGEST: digest, INPUT_TAGS: tags, INPUT_VERSION: '42', ...overrides });
  return { invoke, capture, temp };
}

test('capture writes a caller-provenanced v1 envelope into a private temporary directory', async t => {
  const { capture, temp } = await harness(t);
  const first = await capture();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.output.artifact, artifact);
  const path = first.output.path;
  assert.equal(dirname(dirname(path)), temp);
  const { publishedAt, ...payload } = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(new Date(publishedAt).toISOString(), publishedAt);
  assert.deepEqual(payload, {
    schemaVersion: 1, repository: 'ghcr.io/example/app', tags: ['42', 'latest'], digest, version: '42',
    sourceRepository: context.GITHUB_REPOSITORY, commit: context.GITHUB_SHA, ref: context.GITHUB_REF,
    runId: context.GITHUB_RUN_ID, runAttempt: 1, runUrl: 'https://github.com/Example/workflow-caller/actions/runs/12345',
  });
  const second = await capture({ SERVICES_PUBLISH_IDENTITY_VERSION: '1' });
  assert.equal(second.status, 0, second.stderr);
  assert.notEqual(second.output.path, path);
  assert.equal(JSON.parse(await readFile(second.output.path, 'utf8')).sourceRepositoryId, context.GITHUB_REPOSITORY_ID);
  assert.equal((await capture({ INPUT_VERSION: '0' })).status, 1);
});

test('only an exact artifact name for this run and an eligible attempt reaches download', async t => {
  const { invoke, temp } = await harness(t);
  const current = { GITHUB_RUN_ATTEMPT: '2' };
  const valid = await invoke('prepare', { ...current, INPUT_ARTIFACT: artifact });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(dirname(valid.output.directory), temp);
  for (const name of ['', '../' + artifact, artifact + '\n', 'services-publish-12345-01', 'services-publish-12345-3', 'services-publish-12346-1', 'services-publish-12345-9007199254740992']) {
    const result = await invoke('prepare', { ...current, INPUT_ARTIFACT: name });
    assert.equal(result.status, 1, name);
    assert.deepEqual(result.output, {}, name);
  }
});

test('restore binds envelope to caller, run, ref, SHA, attempt and optional repository ID', async t => {
  const { invoke, capture } = await harness(t);
  const captured = await capture({ SERVICES_PUBLISH_IDENTITY_VERSION: '1' });
  assert.equal(captured.status, 0, captured.stderr);
  const path = captured.output.path;
  const original = await readFile(path, 'utf8');
  const restore = (overrides) => invoke('verify', {
    INPUT_ARTIFACT: artifact, INPUT_DIRECTORY: dirname(path), GITHUB_RUN_ATTEMPT: '2', ...overrides,
  });
  const result = await restore();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.path, path);
  assert.equal(await readFile(path, 'utf8'), original);
  for (const overrides of [
    { GITHUB_REPOSITORY: 'Other/workflow-caller' }, { GITHUB_REPOSITORY_ID: '8' },
    { GITHUB_SHA: 'e'.repeat(40) }, { GITHUB_REF: 'refs/heads/unrelated' },
    { GITHUB_RUN_ID: '12346' }, { INPUT_ARTIFACT: 'services-publish-12345-2' },
    { INPUT_DIRECTORY: dirname(dirname(path)) },
  ]) {
    const invalid = await restore(overrides);
    assert.equal(invalid.status, 1, JSON.stringify(overrides));
    assert.deepEqual(invalid.output, {});
  }
  await writeFile(path, '{');
  assert.equal((await restore()).status, 1);
});

test('send revalidates provenance before making a request', async t => {
  const { invoke, capture } = await harness(t);
  const captured = await capture();
  assert.equal(captured.status, 0, captured.stderr);
  const result = await invoke('send', { INPUT_ARTIFACT: artifact, INPUT_DIRECTORY: dirname(captured.output.path), GITHUB_SHA: 'e'.repeat(40) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid payload provenance/);
});

test('send refuses plaintext HTTP without logging the endpoint or token', async t => {
  const { invoke, capture } = await harness(t);
  const captured = await capture();
  assert.equal(captured.status, 0, captured.stderr);
  const result = await invoke('send', {
    INPUT_ARTIFACT: artifact, INPUT_DIRECTORY: dirname(captured.output.path),
    SERVICES_PUBLISH_URL: 'http://private-fixture.invalid/api/images/published',
    SERVICES_PUBLISH_TOKEN: 'fixture-token-'.repeat(6),
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'Publish notification failed: Invalid endpoint');
});

test('sender retries the exact original retained bytes without rebuilding the envelope', async t => {
  const { capture } = await harness(t);
  const { sendRetainedNotification } = await import('../actions/publish-envelope/notification.mjs');
  const captured = await capture();
  assert.equal(captured.status, 0, captured.stderr);
  const compact = await readFile(captured.output.path, 'utf8');
  assert.equal(JSON.stringify(JSON.parse(compact)), compact);
  const body = `${compact}\n`; // Even insignificant whitespace must survive delivery.
  const bodies = [];
  assert.equal(await sendRetainedNotification({
    endpoint: 'https://example.invalid/api/images/published', token: 'fixture-'.repeat(6), body,
    baseDelayMs: 0, transport: async (_url, options) => {
      bodies.push(options.body);
      return bodies.length === 1 ? new Response(null, { status: 503 }) : Response.json({ result: 'duplicate' });
    },
  }), 'duplicate');
  assert.deepEqual(bodies, [body, body]);
});
