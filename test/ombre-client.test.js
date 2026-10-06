import test from 'node:test';
import assert from 'node:assert/strict';
import { OmbreClient } from '../src/ombre-client.js';

function readClient() {
  const client = new OmbreClient({
    writeEnabled: false,
    readEnabled: true,
    url: 'http://unused.invalid/mcp',
    token: '',
    breathMaxResults: 3,
    breathMaxTokens: 800,
  });
  const calls = [];
  client.call = async (name, args) => {
    calls.push({ name, args });
    return { result: { content: [{ type: 'text', text: '一段材料' }] } };
  };
  return { client, calls };
}

test('strong drives bias what surfaces, and never gate it', async () => {
  const { client, calls } = readClient();

  await client.recentMaterial([
    { key: 'crave', label: '渴求', value: 0.91 },
    { key: 'possess', label: '占有', value: 0.62 },
    { key: 'boredom', label: '无聊', value: 0.12 },
  ]);

  const { query } = calls[0].args;
  assert.match(query, /渴求/);
  assert.match(query, /占有/);
  // 低于阈值的维度不参与，否则十二维会把 query 稀释成噪音。
  assert.doesNotMatch(query, /无聊/);
  // 兜底语必须在：没有它，强驱动力会把召回卡成空。
  assert.match(query, /没有直接相关的就照常返回近期重要的/);
});

test('weak drives leave the recall query untouched', async () => {
  const { client, calls } = readClient();
  const baseline = await readClient();
  await baseline.client.daytimeMaterial();
  await client.daytimeMaterial([{ key: 'crave', label: '渴求', value: 0.2 }]);

  assert.equal(calls[0].args.query, baseline.calls[0].args.query);
  assert.doesNotMatch(calls[0].args.query, /此刻最强的内在状态/);
});

test('autonomous thought recall stays smaller than daytime recall', async () => {
  const { client, calls } = readClient();
  await client.thoughtMaterial([{ key: 'crave', label: '渴求', value: 0.8 }]);

  const { args } = calls[0];
  assert.equal(args.name ?? calls[0].name, 'breath');
  assert.ok(args.max_results <= 3);
  assert.ok(args.max_tokens <= 600);
  assert.match(args.query, /渴求/);
});

test('automatic dream writes identify themselves and never impersonate manual memory', async () => {
  const client = new OmbreClient({
    writeEnabled: true,
    readEnabled: false,
    url: 'http://unused.invalid/mcp',
    token: '',
    breathMaxResults: 3,
    breathMaxTokens: 800,
  });
  let captured;
  client.call = async (name, args) => {
    captured = { name, args };
    return { result: { content: [{ type: 'text', text: '已保存 abcdef123456' }] } };
  };

  await client.storeDream({
    dream: '一盏灯',
    residue: '安静',
    awareness: '记得回来',
  });

  assert.equal(captured.name, 'hold');
  assert.equal(captured.args.auto, true);
  assert.equal(captured.args.source, 'xinchao-dream');
  assert.equal(captured.args.importance, 7);
  assert.equal(captured.args.tags, 'dream');
});

test('strong resident emotion candidate is written with separated fields and read back', async () => {
  const client = new OmbreClient({
    writeEnabled: true,
    readEnabled: false,
    url: 'http://unused.invalid/mcp',
    token: '',
    breathMaxResults: 3,
    breathMaxTokens: 800,
  });
  const calls = [];
  client.call = async (name, args) => {
    calls.push({ name, args });
    if (name === 'hold') {
      return { result: { content: [{ type: 'text', text: '新建→emotion_bucket_001 relationship' }] } };
    }
    return {
      result: {
        content: [{ type: 'text', text: `${args.query} emotion_bucket_001` }],
      },
    };
  };

  const result = await client.storeEmotionCandidate({
    trajectoryKey: 'relationship-jealousy',
    emotion: 'jealousy',
    intensity: 0.9,
    eventSummary: '她用出轨玩笑问我会不会吃醋。',
    residentState: {
      reason: '我在乎她，也想成为她唯一的老公。',
      nextTendency: '主动坦白并记录醋意。',
    },
    reinforcement: false,
  });

  assert.equal(result.status, 'committed');
  assert.equal(result.verified, true);
  assert.equal(result.attempts, 1);
  assert.deepEqual(calls.map((call) => call.name), ['hold', 'breath']);
  assert.match(calls[0].args.content, /^事件：/m);
  assert.match(calls[0].args.content, /^Resident内在状态：/m);
  assert.match(calls[0].args.content, /^原因：/m);
  assert.match(calls[0].args.content, /^后续倾向：/m);
  assert.match(calls[0].args.tags, /resident-emotion/);
});

test('emotion memory classification failure retries the same semantic candidate once', async () => {
  const client = new OmbreClient({
    writeEnabled: true,
    readEnabled: false,
    url: 'http://unused.invalid/mcp',
    token: '',
    breathMaxResults: 3,
    breathMaxTokens: 800,
  });
  const holdPayloads = [];
  client.call = async (name, args) => {
    if (name === 'hold') {
      holdPayloads.push(structuredClone(args));
      if (holdPayloads.length === 1) {
        return { result: { content: [{ type: 'text', text: '打标无法完成，桶未创建' }] } };
      }
      return { result: { content: [{ type: 'text', text: '新建→emotion_bucket_retry relationship' }] } };
    }
    return { result: { content: [{ type: 'text', text: `${args.query} emotion_bucket_retry` }] } };
  };

  const result = await client.storeEmotionCandidate({
    trajectoryKey: 'relationship-jealousy',
    emotion: 'jealousy',
    intensity: 0.8,
    eventSummary: '一次吃醋互动。',
    residentState: { reason: '在乎她。', nextTendency: '主动表达。' },
    reinforcement: true,
  });

  assert.equal(result.status, 'committed');
  assert.equal(result.attempts, 2);
  assert.equal(holdPayloads.length, 2);
  assert.deepEqual(holdPayloads[1], holdPayloads[0]);
});
