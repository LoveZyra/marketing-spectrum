import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { toSdkModel } from '../claude-sdk.js';

/**
 * 'default' 档不下发 model 参数 —— 这条规则的由来:
 *
 * 实测 `claude -p "1" --model default` 发现 CLI 不把 'default' 当别名解析,而是
 * 原样透传给网关,请求落进网关对陌生名字的兜底路由(当时是 glm-5.2[1m]),和
 * settings.json 的 "model" 配置链(sonnet → ANTHROPIC_DEFAULT_SONNET_MODEL)完全
 * 无关。于是同一个"默认档"在 chat、终端、探测三处各走一条路,结果互相对不上。
 *
 * 修法:选 default 时**省略 model**,CLI 才走自己的配置链。这里钉死归一规则,
 * 三个下发点(一次性路径、常驻路径、探测)共用同一语义。
 */
describe('toSdkModel —— default 档省略 model', () => {
  test("'default' 归一为 null(不下发)", () => {
    assert.equal(toSdkModel('default'), null);
  });

  test('带空白的 default 同样不下发', () => {
    assert.equal(toSdkModel('  default  '), null);
  });

  test('空值一律不下发', () => {
    assert.equal(toSdkModel(''), null);
    assert.equal(toSdkModel('   '), null);
    assert.equal(toSdkModel(undefined), null);
    assert.equal(toSdkModel(null), null);
  });

  test('具体别名原样下发(含 [1m] 变体),仅去掉首尾空白', () => {
    assert.equal(toSdkModel('sonnet'), 'sonnet');
    assert.equal(toSdkModel('opus[1m]'), 'opus[1m]');
    assert.equal(toSdkModel(' glm-5.2 '), 'glm-5.2');
  });
});
