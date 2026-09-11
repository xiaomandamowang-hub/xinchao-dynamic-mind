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

test('daytime surfacing uses automatic recall without a synthetic query', async () => {
  const { client, calls } = readClient();
  const baseline = await readClient();
  await baseline.client.daytimeMaterial();
  await client.daytimeMaterial([{ key: 'crave', label: '渴求', value: 0.2 }]);

  assert.equal(calls[0].name, 'breath_advanced');
  assert.equal(baseline.calls[0].args.query, undefined);
  assert.equal(calls[0].args.query, undefined);
  assert.equal(calls[0].args.mode, 'automatic');
});

test('autonomous thought recall uses the bounded automatic surfacing lane', async () => {
  const { client, calls } = readClient();
  await client.thoughtMaterial([{ key: 'crave', label: '渴求', value: 0.8 }]);

  const { args } = calls[0];
  assert.equal(args.name ?? calls[0].name, 'breath_advanced');
  assert.ok(args.max_results <= 3);
  assert.equal(args.max_tokens, 9000);
  assert.equal(args.mode, 'automatic');
  assert.equal(args.query, undefined);
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
  const captured = [];
  client.call = async (name, args) => {
    captured.push({ name, args });
    return { result: { content: [{ type: 'text', text: '已保存 abcdef123456' }] } };
  };

  await client.storeDream({
    dream: '一盏灯',
    residue: '安静',
    awareness: '记得回来',
  });

  assert.equal(captured[0].name, 'hold');
  assert.equal(captured[0].args.auto, true);
  assert.equal(captured[0].args.source, 'xinchao-dream');
  assert.equal(captured[0].args.importance, 7);
  assert.equal(captured[0].args.tags, 'dream');
  assert.equal(captured[1].name, 'trace');
  assert.equal(captured[1].args.dont_surface, 1);
});
