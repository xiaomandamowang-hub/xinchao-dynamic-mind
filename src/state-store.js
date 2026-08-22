import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import {
  STATE_PUBLICATION_PROFILE_CONTROLLED_READER_V1,
  inspectStatePublicationProfile,
} from './state-publication-profile.js';

const OPTION_FIELDS = new Set(['publicationProfile', 'readerGid']);

function dataObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value))
    .every((descriptor) => Object.hasOwn(descriptor, 'value'));
}

function safeError(code) {
  const error = new Error('State publication boundary is invalid.');
  error.code = code;
  error.stack = `${error.name}: ${error.message}`;
  return error;
}

function validateOptions(path, options) {
  if (!dataObject(options) || Object.keys(options).some((field) => !OPTION_FIELDS.has(field))) {
    throw safeError('STATE_PUBLICATION_OPTIONS_INVALID');
  }
  let publication;
  try {
    publication = inspectStatePublicationProfile(options.publicationProfile);
  } catch {
    throw safeError('STATE_PUBLICATION_PROFILE_INVALID');
  }
  const readerGid = options.readerGid ?? null;
  if (publication.profile === STATE_PUBLICATION_PROFILE_CONTROLLED_READER_V1) {
    if (typeof path !== 'string' || !isAbsolute(path) || basename(path) !== 'state.json') {
      throw safeError('STATE_PUBLICATION_PATH_INVALID');
    }
    if (process.platform === 'win32') throw safeError('STATE_PUBLICATION_PLATFORM_UNSUPPORTED');
    if (!Number.isSafeInteger(readerGid) || readerGid < 1) {
      throw safeError('STATE_PUBLICATION_READER_GROUP_INVALID');
    }
  } else if (readerGid !== null) {
    throw safeError('STATE_PUBLICATION_READER_GROUP_UNEXPECTED');
  }
  return Object.freeze({ publication, readerGid });
}

function metadataMatches(stat, { mode, uid, gid }) {
  return stat.isFile() && !stat.isSymbolicLink()
    && (stat.mode & 0o7777) === mode && stat.uid === uid && stat.gid === gid;
}

export class StateStore {
  #queue = Promise.resolve();
  #publication;
  #readerGid;

  constructor(path, factory, options = {}) {
    const validated = validateOptions(path, options);
    this.path = path;
    this.factory = factory;
    this.#publication = validated.publication;
    this.#readerGid = validated.readerGid;
  }

  async #assertControlledDirectory() {
    const directory = dirname(this.path);
    let stat;
    let canonical;
    try {
      [stat, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
    } catch {
      throw safeError('STATE_PUBLICATION_DIRECTORY_INVALID');
    }
    const uid = process.getuid?.();
    if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(canonical) !== resolve(directory)
        || (stat.mode & 0o7777) !== 0o2750 || stat.uid !== uid || stat.gid !== this.#readerGid) {
      throw safeError('STATE_PUBLICATION_DIRECTORY_INVALID');
    }
    return Object.freeze({ uid, gid: this.#readerGid });
  }

  async #assertControlledFile() {
    let stat;
    let canonical;
    try {
      [stat, canonical] = await Promise.all([lstat(this.path), realpath(this.path)]);
    } catch (error) {
      if (error.code === 'ENOENT') throw error;
      throw safeError('STATE_PUBLICATION_FILE_INVALID');
    }
    const expected = { mode: this.#publication.finalFileMode, uid: process.getuid?.(), gid: this.#readerGid };
    if (resolve(canonical) !== resolve(this.path) || !metadataMatches(stat, expected)) {
      throw safeError('STATE_PUBLICATION_FILE_INVALID');
    }
  }

  async read() {
    try {
      if (this.#publication.requiresDedicatedDirectory) await this.#assertControlledFile();
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const state = this.factory();
      await this.write(state);
      return state;
    }
  }

  async write(state) {
    let expected = null;
    if (this.#publication.requiresDedicatedDirectory) {
      expected = await this.#assertControlledDirectory();
    } else {
      await mkdir(dirname(this.path), { recursive: true });
    }
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temp, 'wx', this.#publication.tempFileMode);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
      if (this.#publication.applyFinalModeAfterWrite) {
        await handle.chmod(this.#publication.finalFileMode);
        await handle.sync();
        const published = await handle.stat();
        if (!metadataMatches(published, { ...expected, mode: this.#publication.finalFileMode })) {
          throw safeError('STATE_PUBLICATION_FILE_INVALID');
        }
      }
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, this.path);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      await rm(this.path, { force: true });
      await rename(temp, this.path);
    }
  }

  update(mutator) {
    const operation = this.#queue.then(async () => {
      const current = await this.read();
      const next = await mutator(structuredClone(current));
      await this.write(next);
      return next;
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
}
