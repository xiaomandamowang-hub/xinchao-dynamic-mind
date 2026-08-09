import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, validateServiceToken } from '../src/config.js';


function config(overrides = {}) {
  return {
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
    memoryV1: {
      enabled: false,
      url: '',
      ...(overrides.memoryV1 || {}),
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

test('Memory V1 remains optional and requires only an endpoint when enabled', () => {
  assert.throws(
    () => validateConfig(config({ memoryV1: { enabled: true } })),
    /MEMORY_V1_MCP_URL is required/,
  );
  const value = config({
    memoryV1: { enabled: true, url: 'http://127.0.0.1:18120/mcp' },
  });
  assert.equal(validateConfig(value), value);
});

test('SERVICE_TOKEN startup validation rejects missing, placeholder and short values', () => {
  assert.throws(() => validateServiceToken(''), /SERVICE_TOKEN is required/);
  assert.throws(
    () => validateServiceToken('replace-with-a-random-secret'),
    /still the placeholder/,
  );
  assert.throws(() => validateServiceToken('too-short'), /at least 32 characters/);
});

test('SERVICE_TOKEN startup validation accepts a strong non-placeholder value', () => {
  const token = '0123456789abcdef0123456789abcdef';
  assert.equal(validateServiceToken(token), token);
});
