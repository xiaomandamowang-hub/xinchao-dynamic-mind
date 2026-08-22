import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateConfig } from '../src/config.js';


function config(overrides = {}) {
  return {
    serviceToken: 'service-secret',
    statePath: '/app/state/state.json',
    statePublicationProfile: 'private',
    stateReaderGid: null,
    journalPath: '/app/state/transitions.jsonl',
    ombre: {
      url: '',
      token: '',
      readEnabled: false,
      writeEnabled: false,
      ...(overrides.ombre || {}),
    },
    context: {
      ombreEnabled: false,
      ...(overrides.context || {}),
    },
    dashboard: {
      enabled: false,
      accessToken: '',
      publicBaseUrl: 'https://xinchao.example.com',
      ...(overrides.dashboard || {}),
    },
    bridge: {
      enabled: false,
      machineToken: '',
      statePath: '/app/state/bridge-queue.json',
      ...(overrides.bridge || {}),
    },
    oauth: {
      statePath: '/app/state/oauth.json',
      ...(overrides.oauth || {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['ombre', 'context', 'dashboard', 'bridge', 'oauth'].includes(key))),
  };
}

function controlledPaths() {
  const root = mkdtempSync(join(tmpdir(), 'xinchao-controlled-config-'));
  const directories = Object.fromEntries(
    ['state', 'journal', 'oauth', 'bridge'].map((name) => {
      const value = join(root, name);
      mkdirSync(value);
      return [name, value];
    }),
  );
  return {
    root,
    directories,
    config: {
      statePath: join(directories.state, 'state.json'),
      statePublicationProfile: 'controlled-reader-v1',
      stateReaderGid: 4242,
      journalPath: join(directories.journal, 'transitions.jsonl'),
      oauth: { statePath: join(directories.oauth, 'oauth.json') },
      bridge: { statePath: join(directories.bridge, 'bridge-queue.json') },
    },
  };
}


test('external memory remains optional when every integration is disabled', () => {
  const value = config();
  assert.equal(validateConfig(value), value);
});


for (const enabled of [
  { ombre: { readEnabled: true } },
  { ombre: { writeEnabled: true } },
  { context: { ombreEnabled: true } },
]) {
  test(`external memory requires URL and token: ${JSON.stringify(enabled)}`, () => {
    assert.throws(
      () => validateConfig(config(enabled)),
      /OMBRE_MCP_URL is required/
    );
    assert.throws(
      () => validateConfig(config({
        ...enabled,
        ombre: {
          ...(enabled.ombre || {}),
          url: 'https://memory.example.com/mcp',
        },
      })),
      /OMBRE_MCP_TOKEN is required/
    );
  });
}


test('authenticated external memory configuration is accepted', () => {
  const value = config({
    ombre: {
      url: 'https://memory.example.com/mcp',
      token: 'server-side-bearer',
      readEnabled: true,
    },
  });
  assert.equal(validateConfig(value), value);
});

test('controlled reader publication requires one absolute dedicated state parent and reader gid', () => {
  const paths = controlledPaths();
  const controlledConfig = paths.config;
  assert.equal(validateConfig(config(controlledConfig)).statePublicationProfile, 'controlled-reader-v1');
  assert.throws(() => validateConfig(config({ ...controlledConfig, stateReaderGid: null })), /STATE_READER_GID is required/);
  assert.throws(() => validateConfig(config({ ...controlledConfig, statePath: 'relative/state.json' })), /absolute dedicated STATE_PATH/);
  assert.throws(() => validateConfig(config({ ...controlledConfig, statePath: join(paths.directories.state, 'other.json') })), /ending in state.json/);
  for (const neighbor of [
    { journalPath: join(paths.directories.state, 'transitions.jsonl') },
    { oauth: { statePath: join(paths.directories.state, 'oauth.json') } },
    { bridge: { statePath: join(paths.directories.state, 'bridge-queue.json') } },
  ]) {
    assert.throws(() => validateConfig(config({ ...controlledConfig, ...neighbor })), /dedicated parent directory/);
  }
  assert.throws(() => validateConfig(config({ ...controlledConfig, journalPath: 'relative/transitions.jsonl' })),
    /TRANSITION_JOURNAL_PATH must be an absolute path/);
  assert.throws(() => validateConfig(config({ ...controlledConfig, journalPath: '' })),
    /TRANSITION_JOURNAL_PATH must be an absolute path/);
  assert.throws(() => validateConfig(config({ ...controlledConfig, journalPath: join(paths.root, 'missing', 'transitions.jsonl') })),
    /TRANSITION_JOURNAL_PATH parent directory must already exist/);
});

test('controlled reader canonicalizes neighbor parents before isolation comparison', (t) => {
  const paths = controlledPaths();
  const linked = join(paths.root, 'linked-state-parent');
  try {
    symlinkSync(paths.directories.state, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`symlink unavailable: ${error.code}`);
    throw error;
  }
  assert.throws(() => validateConfig(config({
    ...paths.config,
    journalPath: join(linked, 'transitions.jsonl'),
  })), /dedicated parent directory/);
});

test('publication profile rejects arbitrary modes and unused reader groups', () => {
  assert.throws(() => validateConfig(config({ statePublicationProfile: '0640' })), /STATE_PUBLICATION_PROFILE/);
  assert.throws(() => validateConfig(config({ stateReaderGid: 4242 })), /only valid for controlled-reader-v1/);
});

test('environment loading keeps private as default and parses only a positive reader gid', () => {
  const names = ['STATE_PUBLICATION_PROFILE', 'STATE_READER_GID'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.equal(loadConfig().statePublicationProfile, 'private');
    assert.equal(loadConfig().stateReaderGid, null);
    process.env.STATE_PUBLICATION_PROFILE = 'controlled-reader-v1';
    process.env.STATE_READER_GID = '4242';
    assert.equal(loadConfig().statePublicationProfile, 'controlled-reader-v1');
    assert.equal(loadConfig().stateReaderGid, 4242);
    process.env.STATE_READER_GID = '0';
    assert.throws(() => loadConfig(), /STATE_READER_GID must be a positive integer/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('Dashboard requires a separate strong access token', () => {
  assert.throws(
    () => validateConfig(config({ dashboard: { enabled: true, accessToken: 'short' } })),
    /at least 32 characters/,
  );
  assert.throws(
    () => validateConfig(config({ dashboard: { enabled: true, accessToken: 'service-secret' } })),
    /at least 32 characters/,
  );
  const shared = 'a'.repeat(32);
  const sameSecret = config({ dashboard: { enabled: true, accessToken: shared } });
  sameSecret.serviceToken = shared;
  assert.throws(() => validateConfig(sameSecret), /different from SERVICE_TOKEN/);
  assert.equal(
    validateConfig(config({ dashboard: { enabled: true, accessToken: 'd'.repeat(32) } })).dashboard.enabled,
    true,
  );
});

test('public Dashboard requires an HTTPS base URL', () => {
  const accessToken = 'd'.repeat(32);
  assert.throws(
    () => validateConfig(config({
      dashboard: { enabled: true, accessToken, publicBaseUrl: '' },
    })),
    /DASHBOARD_PUBLIC_BASE_URL is required/,
  );
  assert.throws(
    () => validateConfig(config({
      dashboard: { enabled: true, accessToken, publicBaseUrl: 'http://public.example.com' },
    })),
    /must use HTTPS/,
  );
  assert.equal(
    validateConfig(config({
      dashboard: { enabled: true, accessToken, publicBaseUrl: 'http://127.0.0.1:18110' },
    })).dashboard.enabled,
    true,
  );
});

test('Bridge requires an independent strong machine token', () => {
  assert.throws(() => validateConfig(config({ bridge: { enabled: true, machineToken: 'short' } })), /at least 32 characters/);
  const shared = 'b'.repeat(32);
  const sameAsService = config({ bridge: { enabled: true, machineToken: shared } });
  sameAsService.serviceToken = shared;
  assert.throws(() => validateConfig(sameAsService), /must be independent/);
  assert.equal(validateConfig(config({ bridge: { enabled: true, machineToken: 'm'.repeat(32) } })).bridge.enabled, true);
});
