import assert from 'node:assert/strict';

import { afterEach, describe, it, test } from 'vitest';

import {
  applyServerToolPolicy, mapCliOptionsToSDK, readBypassAllowlist, readForcedDenyTools, runtimeSettingsFromOptions,
} from '../claude-sdk.js';

/**
 * 服务端强制的工具策略。
 *
 * ## 在此之前服务端一句话都说不上
 *
 * 权限档位在聊天框的下拉里**人人可选**,定时任务的 `permission_mode` 更是默认就用
 * `bypassPermissions`(所有工具调用都不弹确认框);而客户端的工具黑白名单存在
 * **浏览器 localStorage** 里 —— 那是用户自己的偏好,随时能清空。
 *
 * 也就是说在多用户部署里,"谁能用 bypass""哪些工具一律禁掉"这两件事,
 * 服务端**没有任何手段**。`.env.example` 里关于 `IS_SANDBOX` 的那段注释已经把代价
 * 写清楚了:放行等于每个登录用户都拿到不受限的执行权限。
 *
 * 这两个开关补上那个手段。都**默认不开** —— 升级上来的部署行为不变。
 */

const baseOptions = {
  cwd: '/tmp/x',
  toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
};

const withEnv = (vars, run) => {
  const prev = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe('PRISM_FORCED_DENY_TOOLS', () => {
  test('解析:逗号分隔、去空白、忽略空项', () => {
    assert.deepEqual(readForcedDenyTools({ PRISM_FORCED_DENY_TOOLS: 'Bash, WebFetch ,,' }), ['Bash', 'WebFetch']);
    assert.deepEqual(readForcedDenyTools({}), []);
  });

  test('客户端覆盖不掉 —— 强制项无条件并进 disallowedTools', () => {
    withEnv({ PRISM_FORCED_DENY_TOOLS: 'Bash,WebFetch' }, () => {
      // 客户端只禁了 Write、完全没提 Bash —— 强制项照样要在
      const sdk = mapCliOptionsToSDK({
        ...baseOptions,
        toolsSettings: { allowedTools: [], disallowedTools: ['Write'], skipPermissions: false },
      });
      assert.ok(sdk.disallowedTools.includes('Bash'), '强制禁用项被客户端设置顶掉了');
      assert.ok(sdk.disallowedTools.includes('WebFetch'));
      assert.ok(sdk.disallowedTools.includes('Write'), '客户端自己的禁用项不该被吃掉');
    });
  });

  test('没配时行为不变', () => {
    withEnv({ PRISM_FORCED_DENY_TOOLS: undefined }, () => {
      const sdk = mapCliOptionsToSDK({
        ...baseOptions,
        toolsSettings: { allowedTools: [], disallowedTools: ['Write'], skipPermissions: false },
      });
      assert.deepEqual(sdk.disallowedTools, ['Write']);
    });
  });
});

describe('PRISM_ALLOW_BYPASS_USERS', () => {
  test('没配 = 不限制;配了但为空 = 谁都不许 —— 两者必须分得开', () => {
    assert.equal(readBypassAllowlist({}), null, '没配应当返回 null(不限制)');
    assert.equal(readBypassAllowlist({ PRISM_ALLOW_BYPASS_USERS: '  ' }), null, '空白串等同于没配');
    const empty = readBypassAllowlist({ PRISM_ALLOW_BYPASS_USERS: ',,' });
    assert.ok(empty instanceof Set && empty.size === 0, '配了但没有有效项应当是空 Set(谁都不许)');
  });

  test('名单小写归一 —— 与 isRootUser / users.username 的 NOCASE 同口径', () => {
    const list = readBypassAllowlist({ PRISM_ALLOW_BYPASS_USERS: 'Alice, BOB' });
    assert.ok(list.has('alice') && list.has('bob'), '名单没归一,配 Alice 时 alice 会被挡在外面');
  });

  test('不在名单里 → 从 bypassPermissions 降级为 acceptEdits(而不是拒绝整轮)', () => {
    withEnv({ PRISM_ALLOW_BYPASS_USERS: 'boss' }, () => {
      const sdk = mapCliOptionsToSDK({
        ...baseOptions,
        permissionMode: 'bypassPermissions',
        actorUsername: 'mallory',
      });
      // 降级而不是抛错:拒绝会让一轮对话凭空失败,降级只是把确认框还回来
      assert.equal(sdk.permissionMode, 'acceptEdits');
    });
  });

  test('在名单里 → 照常 bypass(大小写不敏感)', () => {
    withEnv({ PRISM_ALLOW_BYPASS_USERS: 'boss' }, () => {
      for (const name of ['boss', 'BOSS', ' Boss ']) {
        const sdk = mapCliOptionsToSDK({ ...baseOptions, permissionMode: 'bypassPermissions', actorUsername: name });
        assert.equal(sdk.permissionMode, 'bypassPermissions', `名单里的 ${name} 被误降级`);
      }
    });
  });

  test('没配名单时维持现状 —— 升级上来的部署不会突然有人跑不了任务', () => {
    withEnv({ PRISM_ALLOW_BYPASS_USERS: undefined }, () => {
      const sdk = mapCliOptionsToSDK({ ...baseOptions, permissionMode: 'bypassPermissions', actorUsername: 'anyone' });
      assert.equal(sdk.permissionMode, 'bypassPermissions');
    });
  });

  test('skipPermissions 这条老路径也走同一道闸', () => {
    withEnv({ PRISM_ALLOW_BYPASS_USERS: 'boss' }, () => {
      // toolsSettings.skipPermissions 会把档位改成 bypassPermissions —— 那条路也必须被拦住,
      // 否则白名单等于只挡了下拉框、没挡住设置项。
      const sdk = mapCliOptionsToSDK({
        ...baseOptions,
        toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: true },
        actorUsername: 'mallory',
      });
      assert.equal(sdk.permissionMode, 'acceptEdits');
    });
  });
});

/**
 * fj:两条执行路径必须给出**同一个**策略结果。
 *
 * 修之前:强制黑名单与 bypass 白名单只写在 `mapCliOptionsToSDK` 里,而那个函数
 * 只被一次性路径(外部 API)调用。网页聊天默认走常驻 runtime,它的 settings 由
 * `runtimeSettingsFromOptions` 构造 —— 两道闸一道都不过。
 *
 * 也就是说:**越是交互式、人人可用的那条路,管得越松**。这一组把两条路钉在一起。
 */
describe('fj:常驻路径与一次性路径的策略必须一致', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('强制黑名单在常驻路径上也生效', () => {
    process.env.PRISM_FORCED_DENY_TOOLS = 'Bash,WebFetch';
    const policed = applyServerToolPolicy('default', ['Write'], 'alice');
    assert.ok(policed.disallowedTools.includes('Bash'), '强制禁用的 Bash 必须在清单里');
    assert.ok(policed.disallowedTools.includes('WebFetch'));
    assert.ok(policed.disallowedTools.includes('Write'), '客户端自己勾的也要留着');
  });

  it('客户端覆盖不掉强制黑名单', () => {
    process.env.PRISM_FORCED_DENY_TOOLS = 'Bash';
    // 客户端一条都不禁,强制的照样进去
    assert.ok(applyServerToolPolicy('default', [], 'alice').disallowedTools.includes('Bash'));
  });

  it('不在白名单里的人拿不到 bypassPermissions —— 降级为 acceptEdits', () => {
    process.env.PRISM_ALLOW_BYPASS_USERS = 'boss';
    assert.equal(applyServerToolPolicy('bypassPermissions', [], 'mallory').permissionMode, 'acceptEdits');
    assert.equal(applyServerToolPolicy('bypassPermissions', [], 'boss').permissionMode, 'bypassPermissions');
  });

  it('没配白名单时维持现状(全员可用),升级上来的部署不会突然跑不了', () => {
    delete process.env.PRISM_ALLOW_BYPASS_USERS;
    assert.equal(applyServerToolPolicy('bypassPermissions', [], 'anyone').permissionMode, 'bypassPermissions');
  });

  it('两条路的入口都真的调了它 —— mapCliOptionsToSDK 的结果与直接调等价', () => {
    process.env.PRISM_FORCED_DENY_TOOLS = 'Bash';
    process.env.PRISM_ALLOW_BYPASS_USERS = 'boss';
    const mapped = mapCliOptionsToSDK({
      actorUsername: 'mallory',
      toolsSettings: { allowedTools: [], disallowedTools: ['Write'], skipPermissions: true },
    });
    const direct = applyServerToolPolicy('bypassPermissions', ['Write'], 'mallory');
    assert.deepEqual([...mapped.disallowedTools].sort(), [...direct.disallowedTools].sort());
    assert.equal(mapped.permissionMode, direct.permissionMode);
  });
});

describe('fj:常驻路径的 settings 构造点本身', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('runtimeSettingsFromOptions 并入强制黑名单 —— 网页聊天走的就是它', () => {
    process.env.PRISM_FORCED_DENY_TOOLS = 'Bash';
    const settings = runtimeSettingsFromOptions({
      toolsSettings: { allowedTools: [], disallowedTools: ['Write'], skipPermissions: false },
      actorUsername: 'alice',
    });
    assert.ok(settings.disallowedTools.includes('Bash'), '强制禁用没并进常驻 settings');
    assert.ok(settings.disallowedTools.includes('Write'));
  });

  it('runtimeSettingsFromOptions 认 bypass 白名单 —— 任何人都能在下拉里选「跳过权限」', () => {
    process.env.PRISM_ALLOW_BYPASS_USERS = 'boss';
    const mallory = runtimeSettingsFromOptions({
      toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: true },
      actorUsername: 'mallory',
    });
    assert.equal(mallory.permissionMode, 'acceptEdits');
    const boss = runtimeSettingsFromOptions({
      toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: true },
      actorUsername: 'boss',
    });
    assert.equal(boss.permissionMode, 'bypassPermissions');
  });

  it('plan 档照旧补齐只读工具,且不被降级逻辑波及', () => {
    process.env.PRISM_ALLOW_BYPASS_USERS = 'boss';
    const settings = runtimeSettingsFromOptions({
      permissionMode: 'plan',
      toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: true },
      actorUsername: 'mallory',
    });
    assert.equal(settings.permissionMode, 'plan');
    assert.ok(settings.allowedTools.includes('Read'));
  });
});
