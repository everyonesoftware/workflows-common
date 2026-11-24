export function createPayload(env, publishedAt = new Date().toISOString()) {
  check(typeof env.PUBLISHED_TAGS === 'string' && env.PUBLISHED_TAGS.length > 0, 'PUBLISHED_TAGS');
  const references = env.PUBLISHED_TAGS.split('\n');
  const repository = references[0].slice(0, references[0].lastIndexOf(':'));
  check(references.every(reference => reference.startsWith(`${repository}:`) && reference.split(':').length === 2), 'PUBLISHED_TAGS');
  check(/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') && Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT)), 'GITHUB_RUN_ATTEMPT');
  const payload = {
    schemaVersion: 1, repository,
    tags: references.map(reference => reference.slice(reference.lastIndexOf(':') + 1)),
    digest: env.PUBLISHED_DIGEST, version: env.APP_VERSION,
    sourceRepository: env.GITHUB_REPOSITORY, commit: env.GITHUB_SHA,
    // Opt in only after upgrading the receiver; old receivers reject unknown fields.
    ...(env.SERVICES_PUBLISH_IDENTITY_VERSION === '1' ? { sourceRepositoryId: env.GITHUB_REPOSITORY_ID } : {}),
    ref: env.GITHUB_REF, runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    runUrl: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    publishedAt,
  };
  validatePayload(payload);
  return payload;
}

function check(condition, field) {
  if (!condition) throw new Error(`Invalid ${field}`);
}

export function validatePayload(payload) {
  check(payload && typeof payload === 'object' && !Array.isArray(payload), 'payload');
  const fields = ['schemaVersion', 'repository', 'tags', 'digest', 'version', 'sourceRepository', 'commit', 'ref', 'runId', 'runAttempt', 'runUrl', 'publishedAt'];
  const optionalIdentity = Object.hasOwn(payload, 'sourceRepositoryId');
  check(Object.keys(payload).length === fields.length + Number(optionalIdentity) && fields.every(key => Object.hasOwn(payload, key)), 'payload fields');
  if (optionalIdentity) {
    // Decimal text avoids rounding immutable IDs above JavaScript's safe integer limit.
    check(typeof payload.sourceRepositoryId === 'string' && /^[1-9][0-9]{0,18}$/.test(payload.sourceRepositoryId) && BigInt(payload.sourceRepositoryId) <= 9223372036854775807n, 'sourceRepositoryId');
  }
  const matches = (field, pattern) => check(typeof payload[field] === 'string' && pattern.test(payload[field]), field);
  check(payload.schemaVersion === 1, 'schemaVersion');
  matches('repository', /^ghcr\.io\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)+$/);
  check(payload.repository.length <= 255, 'repository');
  check(Array.isArray(payload.tags) && payload.tags.length > 0 && payload.tags.length <= 64 && payload.tags.every(tag => typeof tag === 'string' && /^[\w][\w.-]{0,127}$/.test(tag)) && new Set(payload.tags).size === payload.tags.length, 'tags');
  matches('digest', /^sha256:[a-f0-9]{64}$/);
  matches('version', /^[1-9]\d*$/);
  matches('sourceRepository', /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
  // Image names need not match the source repo (e.g. finance vs finance-typescript).
  // The receiver's exact repository allowlist scopes which images may be announced.
  matches('commit', /^[a-f0-9]{40}$/);
  matches('ref', /^refs\/(heads|tags)\/[^\s\x00-\x1f\x7f~^:?*\[\\]+$/);
  check(!payload.ref.includes('..') && !payload.ref.includes('@{') && payload.ref.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock')) && !payload.ref.endsWith('.'), 'ref');
  matches('runId', /^[1-9]\d*$/);
  check(Number.isSafeInteger(payload.runAttempt) && payload.runAttempt > 0, 'runAttempt');
  check(payload.runUrl === `https://github.com/${payload.sourceRepository}/actions/runs/${payload.runId}`, 'runUrl');
  matches('publishedAt', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const timestamp = new Date(payload.publishedAt);
  check(Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === payload.publishedAt, 'publishedAt');
}

// Only errors created locally may retain diagnostic text through sanitization.
class NotificationFailure extends Error {}

export async function sendNotification({ payload, ...options }) {
  validatePayload(payload);
  return postNotification({ ...options, body: JSON.stringify(payload) });
}

export function parseEnvelope(body) {
  let payload;
  try { payload = JSON.parse(body); }
  catch { throw new Error('Invalid payload file'); }
  validatePayload(payload);
  return payload;
}

export async function sendRetainedNotification({ body, ...options }) {
  parseEnvelope(body);
  return postNotification({ ...options, body });
}

async function postNotification({ endpoint, token, body, transport = fetch, maxAttempts = 4, timeoutMs = 10_000, baseDelayMs = 1_000 }) {
  check(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 5 && Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30_000 && Number.isInteger(baseDelayMs) && baseDelayMs >= 0 && baseDelayMs <= 5_000, 'retry options');
  check(typeof token === 'string' && /^[\x21-\x7e]{32,}$/.test(token), 'token');
  check(typeof endpoint === 'string' && endpoint === endpoint.trim() && !/[\s\\]/.test(endpoint), 'endpoint');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Invalid endpoint'); }
  check(url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/api/images/published', 'endpoint');

  let lastStatus;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let transient = false;
    try {
      const response = await transport(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body, redirect: 'manual', signal: controller.signal,
      });
      lastStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined;
      if (response.status === 408 || response.status === 429 || response.status >= 500 && response.status <= 599) {
        transient = true;
        await response.body?.cancel();
      } else {
        if (!response.ok) {
          await response.body?.cancel();
          throw new NotificationFailure(lastStatus ? `Notification rejected (HTTP ${lastStatus})` : 'Notification rejected or invalid acknowledgement');
        }
        let acknowledgement;
        try { acknowledgement = await response.json(); }
        catch (error) {
          // Only completed malformed JSON is permanent. Body I/O and aborts
          // retain their original type/code for the outer transient classifier.
          if (!(error instanceof SyntaxError)) throw error;
          throw new NotificationFailure(lastStatus ? `Notification invalid acknowledgement (HTTP ${lastStatus})` : 'Notification rejected or invalid acknowledgement');
        }
        if (!['accepted', 'duplicate', 'stale'].includes(acknowledgement?.result)) throw new NotificationFailure(lastStatus ? `Notification invalid acknowledgement (HTTP ${lastStatus})` : 'Notification rejected or invalid acknowledgement');
        return acknowledgement.result;
      }
    } catch (error) {
      // Never expose URLs, credentials, response bodies or fetch exception text.
      if (error instanceof NotificationFailure) throw error;
      const transientCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
      transient = transient || controller.signal.aborted || transientCodes.has(error.cause?.code ?? error.code);
      if (!transient) throw new Error('Notification rejected or invalid acknowledgement');
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
  }
  throw new Error(`Notification failed after ${maxAttempts} attempts${lastStatus ? ` (last HTTP ${lastStatus})` : ''}`);
}

export function safeDiagnostic(error) {
  return /^(Invalid [A-Za-z_ ]+|Notification rejected or invalid acknowledgement|Notification (?:rejected|invalid acknowledgement) \(HTTP [1-5][0-9]{2}\)|Notification failed after [1-5] attempts(?: \(last HTTP [1-5][0-9]{2}\))?)$/.test(error?.message) ? error.message : 'operation failed';
}
