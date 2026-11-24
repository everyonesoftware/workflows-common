import { appendFile, lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPayload, parseEnvelope, safeDiagnostic, sendRetainedNotification } from './notification.mjs';

const env = process.env;
const input = name => env[`INPUT_${name.toUpperCase()}`];
const positiveDecimal = /^[1-9][0-9]*(?![\s\S])/;
const maxEnvelopeBytes = 64 * 1024;
const filename = 'published.json';

function attemptFor(artifact) {
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT;
  const match = /^services-publish-([1-9][0-9]*)-([1-9][0-9]*)(?![\s\S])/.exec(artifact ?? '');
  const captured = Number(match?.[2]);
  const current = Number(attempt);
  if (!match || match[1] !== runId || !positiveDecimal.test(attempt ?? '') ||
      !Number.isSafeInteger(current) || !Number.isSafeInteger(captured) || captured > current) {
    throw new Error('Invalid artifact name');
  }
  return captured;
}

async function privateDirectory() {
  try { return await mkdtemp(join(env.RUNNER_TEMP, 'services-publish-')); }
  catch { throw new Error('Invalid temporary directory'); }
}

async function outputs(values) {
  const lines = Object.entries(values).map(([key, value]) => {
    if (/[\r\n]/.test(value)) throw new Error('Invalid output');
    return `${key}=${value}\n`;
  }).join('');
  await appendFile(env.GITHUB_OUTPUT, lines);
}

async function restore() {
  const attempt = attemptFor(input('artifact'));
  if (!input('directory')) throw new Error('Invalid payload directory');
  const path = join(input('directory'), filename);
  let body;
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.size > maxEnvelopeBytes) throw new Error();
    // Capture writes UTF-8. Reject invalid UTF-8 instead of changing retained bytes.
    body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path));
  } catch { throw new Error('Invalid payload file'); }
  const payload = parseEnvelope(body);
  if (payload.sourceRepository !== env.GITHUB_REPOSITORY || payload.commit !== env.GITHUB_SHA ||
      payload.ref !== env.GITHUB_REF || payload.runId !== env.GITHUB_RUN_ID || payload.runAttempt !== attempt ||
      (Object.hasOwn(payload, 'sourceRepositoryId') && payload.sourceRepositoryId !== env.GITHUB_REPOSITORY_ID)) {
    throw new Error('Invalid payload provenance');
  }
  return { path, body };
}

async function main() {
  switch (input('mode')) {
    case 'capture': {
      const payload = createPayload({
        ...env, PUBLISHED_DIGEST: input('digest'), PUBLISHED_TAGS: input('tags'), APP_VERSION: input('version'),
      });
      const artifact = `services-publish-${payload.runId}-${payload.runAttempt}`;
      attemptFor(artifact);
      // Match the legacy sender's compact wire representation.
      const body = JSON.stringify(payload);
      if (Buffer.byteLength(body) > maxEnvelopeBytes) throw new Error('Invalid payload size');
      const path = join(await privateDirectory(), filename);
      await writeFile(path, body, { flag: 'wx', mode: 0o600 });
      await outputs({ artifact, path });
      break;
    }
    case 'prepare':
      attemptFor(input('artifact'));
      await outputs({ directory: await privateDirectory() });
      break;
    case 'verify': {
      const { path } = await restore();
      await outputs({ path });
      break;
    }
    case 'send': {
      const { body } = await restore();
      const result = await sendRetainedNotification({
        endpoint: env.SERVICES_PUBLISH_URL, token: env.SERVICES_PUBLISH_TOKEN, body,
      });
      console.log(`Publish notification acknowledged: ${result}`);
      break;
    }
    default:
      throw new Error('Invalid command');
  }
}

try { await main(); }
catch (error) {
  console.error(`Publish notification failed: ${safeDiagnostic(error)}`);
  process.exitCode = 1;
}
