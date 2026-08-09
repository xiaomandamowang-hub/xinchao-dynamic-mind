import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SYSTEM_VERSION } from '../src/version.js';

test('the runtime version constant matches package.json', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(SYSTEM_VERSION, packageJson.version);
});
