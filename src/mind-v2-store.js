import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  MindV2StateError,
  newMindV2State,
  validateMindV2State,
} from './mind-v2-state.js';

function digest(state) {
  if (!state) return null;
  return createHash('sha256')
    .update(JSON.stringify(state))
    .digest('hex')
    .slice(0, 16);
}

function diagnostic(status, state = null, errorCode = null) {
  return {
    status,
    state,
    digest: digest(state),
    errorCode,
  };
}

function errorCode(error) {
  if (error instanceof MindV2StateError) return error.code;
  if (error instanceof SyntaxError) return 'mind_v2_parse_failed';
  return 'mind_v2_io_failed';
}

export class MindV2Store {
  #queue = Promise.resolve();

  constructor(path, { enabled = false, factory = () => newMindV2State() } = {}) {
    this.path = path;
    this.enabled = enabled;
    this.factory = factory;
  }

  async initialize() {
    if (!this.enabled) return diagnostic('disabled');
    try {
      const state = validateMindV2State(JSON.parse(await readFile(this.path, 'utf8')));
      return diagnostic('ready', state);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        return diagnostic('omitted', null, errorCode(error));
      }
      try {
        const state = validateMindV2State(this.factory());
        await this.write(state);
        return diagnostic('created', state);
      } catch (creationError) {
        return diagnostic('omitted', null, errorCode(creationError));
      }
    }
  }

  async read() {
    return (await this.initialize()).state;
  }

  async write(state) {
    if (!this.enabled) throw new MindV2StateError('mind_v2_store_disabled');
    validateMindV2State(state);
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    let renamed = false;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await handle.sync();
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
      renamed = true;
      await chmod(this.path, 0o600);
      if (process.platform !== 'win32') {
        const directory = await open(dirname(this.path), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      if (!renamed) await rm(temp, { force: true });
    }
  }

  update(mutator) {
    const operation = this.#queue.then(async () => {
      const result = await this.initialize();
      if (!result.state) {
        throw new MindV2StateError(result.errorCode ?? 'mind_v2_store_disabled');
      }
      const next = await mutator(structuredClone(result.state));
      if (JSON.stringify(next) !== JSON.stringify(result.state)) {
        await this.write(next);
      }
      return next;
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
}
