import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const validator = fileURLToPath(new URL('../actions/validate-native-build/validate.ps1', import.meta.url));

test('native build input and staged artifact validation', async t => {
  assert.ok(existsSync(validator), 'native build validator is missing');
  const workspace = mkdtempSync(join(tmpdir(), 'native-build-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, 'scripts'));
  writeFileSync(join(workspace, 'scripts', 'build.sh'), 'true\n');
  const env = {
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    BUILD_SCRIPT: 'scripts/build.sh',
    SCRIPT_EXTENSION: '.sh',
    RELEASE_VERSION: '0.1.42-preview.1',
    ARTIFACT_NAME: 'fixture-android-42',
    RELEASE_ARTIFACT_DIR: 'dist/android',
    VALIDATION_PHASE: 'inputs',
  };
  const run = (overrides = {}) => {
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-File', validator], {
      env: { ...env, ...overrides }, encoding: 'utf8',
    });
    assert.ifError(result.error);
    return result;
  };
  const passes = (overrides) => {
    const result = run(overrides);
    assert.equal(result.status, 0, result.stderr);
  };
  const fails = (overrides, message) => {
    const result = run(overrides);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  };
  await t.test('allows a caller script and a not-yet-created staging directory', () => passes());
  await t.test('rejects incorrect extensions and absent scripts', () => {
    fails({ SCRIPT_EXTENSION: '.ps1' }, /build-script/);
    fails({ BUILD_SCRIPT: 'scripts/missing.sh' }, /build-script/);
  });
  await t.test('rejects nonliteral or escaping paths and invalid metadata', () => {
    for (const path of ['dist/../out', '/out', 'C:/out', 'dist/*', '.git', 'dist\nout']) {
      fails({ RELEASE_ARTIFACT_DIR: path }, /artifact-path/);
    }
    fails({ ARTIFACT_NAME: 'bad/name' }, /artifact-name/);
    fails({ RELEASE_VERSION: '' }, /version/);
  });
  await t.test('requires a staging directory before upload and forbids symlinks', () => {
    const artifact = { VALIDATION_PHASE: 'artifact' };
    fails(artifact, /artifact-path/);
    const dir = join(workspace, 'dist', 'android');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'example.apk'), 'fixture');
    passes(artifact);
    symlinkSync(join(workspace, 'scripts'), join(dir, 'linked-dir'), 'junction');
    fails(artifact, /link|reparse/i);
    symlinkSync(dir, join(workspace, 'linked-stage'), 'junction');
    fails({ RELEASE_ARTIFACT_DIR: 'linked-stage' }, /link|reparse/i);
  });
});

test('the Android signed step runs the build only with all four credentials', t => {
  const workflow = readFileSync(new URL('../.github/workflows/build-android-v1.yml', import.meta.url), 'utf8');
  const script = workflow.match(/- name: Run caller build with signing credentials\r?\n[\s\S]+?\r?\n        run: \|\r?\n([\s\S]+?)(?=\r?\n      - name:)/)?.[1]?.replace(/^ {10}/gm, '');
  assert.ok(script, 'signed build command is missing');
  const workspace = mkdtempSync(join(tmpdir(), 'native-signing-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'fixture.sh'), 'printf "fixture ran\\n"\n');
  const credentials = {
    RELEASE_KEYSTORE_BASE64: 'fixture-key-material',
    RELEASE_KEYSTORE_PASSWORD: 'fixture-store-password',
    RELEASE_KEY_ALIAS: 'fixture-alias',
    RELEASE_KEY_PASSWORD: 'fixture-key-password',
  };
  const run = (overrides) => {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd: workspace, env: { ...process.env, ...credentials, BUILD_SCRIPT: 'fixture.sh', ...overrides }, encoding: 'utf8',
    });
    assert.ifError(result.error);
    for (const secret of Object.values(credentials)) {
      assert.ok(!(result.stdout + result.stderr).includes(secret), 'credential was logged');
    }
    return result;
  };
  for (const name of Object.keys(credentials)) {
    const result = run({ [name]: '' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Missing Android signing credential/);
    assert.doesNotMatch(result.stdout, /fixture ran/);
  }
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixture ran/);
});
