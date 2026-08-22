import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../src/state-store.js';
import {
  STATE_PUBLICATION_PROFILE_CONTROLLED_READER_V1,
  inspectStatePublicationProfile,
} from '../src/state-publication-profile.js';

test('serializes concurrent updates and leaves valid JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dynamic-mind-'));
  const path = join(dir, 'state.json');
  const store = new StateStore(path, () => ({ count: 0 }));
  await Promise.all(Array.from({ length: 20 }, () => store.update((state) => ({ count: state.count + 1 }))));
  assert.equal((await store.read()).count, 20);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).count, 20);
});

test('publication profiles keep private as the secure default', () => {
  assert.deepEqual(inspectStatePublicationProfile(), {
    profile: 'private',
    tempFileMode: 0o600,
    finalFileMode: 0o600,
    applyFinalModeAfterWrite: false,
    requiresDedicatedDirectory: false,
  });
  assert.deepEqual(inspectStatePublicationProfile(STATE_PUBLICATION_PROFILE_CONTROLLED_READER_V1), {
    profile: 'controlled-reader-v1',
    tempFileMode: 0o600,
    finalFileMode: 0o640,
    applyFinalModeAfterWrite: true,
    requiresDedicatedDirectory: true,
  });
  assert.throws(() => inspectStatePublicationProfile('0640'), /STATE_PUBLICATION_PROFILE/);
});

test('StateStore rejects arbitrary modes, extra options, and reader groups on the private profile', () => {
  const path = join(tmpdir(), 'not-opened-state.json');
  assert.throws(() => new StateStore(path, () => ({}), { publicationProfile: '0640' }),
    (error) => error.code === 'STATE_PUBLICATION_PROFILE_INVALID');
  assert.throws(() => new StateStore(path, () => ({}), { mode: 0o777 }),
    (error) => error.code === 'STATE_PUBLICATION_OPTIONS_INVALID');
  assert.throws(() => new StateStore(path, () => ({}), { readerGid: 123 }),
    (error) => error.code === 'STATE_PUBLICATION_READER_GROUP_UNEXPECTED');
  let getterReads = 0;
  const options = {};
  Object.defineProperty(options, 'publicationProfile', {
    enumerable: true,
    get() { getterReads += 1; return 'controlled-reader-v1'; },
  });
  assert.throws(() => new StateStore(path, () => ({}), options),
    (error) => error.code === 'STATE_PUBLICATION_OPTIONS_INVALID');
  assert.equal(getterReads, 0);
});

test('controlled publication rejects unsupported platforms or a missing reader group', () => {
  const path = join(tmpdir(), 'state.json');
  assert.throws(() => new StateStore('relative/state.json', () => ({}), {
    publicationProfile: 'controlled-reader-v1', readerGid: 4242,
  }), (error) => error.code === 'STATE_PUBLICATION_PATH_INVALID');
  assert.throws(() => new StateStore(join(tmpdir(), 'other.json'), () => ({}), {
    publicationProfile: 'controlled-reader-v1', readerGid: 4242,
  }), (error) => error.code === 'STATE_PUBLICATION_PATH_INVALID');
  if (process.platform === 'win32') {
    assert.throws(() => new StateStore(path, () => ({}), {
      publicationProfile: 'controlled-reader-v1', readerGid: 4242,
    }), (error) => error.code === 'STATE_PUBLICATION_PLATFORM_UNSUPPORTED');
  } else {
    assert.throws(() => new StateStore(path, () => ({}), {
      publicationProfile: 'controlled-reader-v1',
    }), (error) => error.code === 'STATE_PUBLICATION_READER_GROUP_INVALID');
  }
});

test('controlled publication overrides a strict umask only after a complete write', {
  skip: process.platform === 'win32' ? 'POSIX permission semantics required' : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-controlled-state-'));
  const directoryStat = await stat(directory);
  await chmod(directory, 0o2750);
  const path = join(directory, 'state.json');
  const previousUmask = process.umask(0o077);
  try {
    const store = new StateStore(path, () => ({ count: 0 }), {
      publicationProfile: 'controlled-reader-v1',
      readerGid: directoryStat.gid,
    });
    await store.write({ count: 1 });
    const published = await stat(path);
    assert.equal(published.mode & 0o7777, 0o640);
    assert.equal(published.gid, directoryStat.gid);
    assert.deepEqual(await readdir(directory), ['state.json']);
    assert.equal((await store.read()).count, 1);
  } finally {
    process.umask(previousUmask);
  }
});

test('controlled read bootstraps only inside a valid directory and rejects published mode drift', {
  skip: process.platform === 'win32' ? 'POSIX permission semantics required' : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-controlled-bootstrap-'));
  const directoryStat = await stat(directory);
  await chmod(directory, 0o2750);
  const path = join(directory, 'state.json');
  const store = new StateStore(path, () => ({ bootstrapped: true }), {
    publicationProfile: 'controlled-reader-v1', readerGid: directoryStat.gid,
  });
  assert.deepEqual(await store.read(), { bootstrapped: true });
  await chmod(path, 0o644);
  await assert.rejects(() => store.read(), (error) => error.code === 'STATE_PUBLICATION_FILE_INVALID');
});

test('controlled publication rejects wrong directory mode gid and linked directory', {
  skip: process.platform === 'win32' ? 'POSIX permission semantics required' : false,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-controlled-invalid-'));
  const directoryStat = await stat(directory);
  const options = { publicationProfile: 'controlled-reader-v1', readerGid: directoryStat.gid };
  const wrongMode = new StateStore(join(directory, 'state.json'), () => ({}), options);
  await assert.rejects(() => wrongMode.write({}), (error) => error.code === 'STATE_PUBLICATION_DIRECTORY_INVALID');
  await chmod(directory, 0o2750);
  const wrongGroup = new StateStore(join(directory, 'state.json'), () => ({}), {
    publicationProfile: 'controlled-reader-v1', readerGid: directoryStat.gid + 1,
  });
  await assert.rejects(() => wrongGroup.write({}), (error) => error.code === 'STATE_PUBLICATION_DIRECTORY_INVALID');
  const linked = `${directory}-link`;
  try {
    await symlink(directory, linked, 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`symlink unavailable: ${error.code}`);
    throw error;
  }
  const linkedStore = new StateStore(join(linked, 'state.json'), () => ({}), options);
  await assert.rejects(() => linkedStore.write({}), (error) => error.code === 'STATE_PUBLICATION_DIRECTORY_INVALID');
});

test('controlled publication sequence is complete-before-readable and rename-last', async () => {
  const source = await readFile(new URL('../src/state-store.js', import.meta.url), 'utf8');
  const openAt = source.indexOf("open(temp, 'wx', this.#publication.tempFileMode)");
  const writeAt = source.indexOf('await handle.writeFile');
  const syncs = [...source.matchAll(/await handle\.sync\(\);/g)].map((match) => match.index);
  const chmodAt = source.indexOf('await handle.chmod(this.#publication.finalFileMode)');
  const statAt = source.indexOf('const published = await handle.stat()');
  const closeAt = source.indexOf('await handle.close()');
  const renameAt = source.indexOf('await rename(temp, this.path)');
  assert.equal(syncs.length, 2);
  assert.equal(openAt < writeAt && writeAt < syncs[0] && syncs[0] < chmodAt, true);
  assert.equal(chmodAt < syncs[1] && syncs[1] < statAt && statAt < closeAt && closeAt < renameAt, true);
});

test('only the primary server store receives publication options', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const bridge = await readFile(new URL('../src/bridge-queue.js', import.meta.url), 'utf8');
  const oauth = await readFile(new URL('../src/oauth-provider.js', import.meta.url), 'utf8');
  assert.equal((server.match(/publicationProfile:/g) ?? []).length, 1);
  assert.match(server, /new StateStore\(config\.statePath,[\s\S]*publicationProfile: config\.statePublicationProfile/);
  assert.match(bridge, /new StateStore\(path, initialQueue\);/);
  assert.doesNotMatch(bridge, /publicationProfile|readerGid/);
  assert.match(oauth, /chmod\(this\.statePath, 0o600\)/);
  assert.doesNotMatch(oauth, /publicationProfile|readerGid/);
});
