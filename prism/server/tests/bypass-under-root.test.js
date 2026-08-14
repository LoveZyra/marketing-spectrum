import assert from 'node:assert/strict';

import { afterEach, describe, test } from 'vitest';

import { describeBypassUnderRoot } from '../claude-sdk.js';

/**
 * 「跳过权限」档位在 root 下会被 claude CLI 直接拒掉。
 *
 * 真实事故:线上所有人突然发不出消息,聊天里只有
 * `Claude Code process exited with code 1`,服务端日志里同样只有这一句。
 * 手动跑 `claude -p "hi"` 却完全正常 —— 因为手跑时没带 `--dangerously-skip-permissions`。
 * 真正的原因藏在子进程的 stderr 里,而当时 Prism 没接那个回调,整句话进了黑洞。
 *
 * CLI 的判断逐字是:uid === 0 且 `IS_SANDBOX !== '1'` 且没有 `CLAUDE_CODE_BUBBLEWRAP`。
 * 这里把同一个条件复刻一遍,好在**拉起子进程之前**就把话说明白。
 *
 * 注意只有这一个档位受影响 —— 其余四个在 root 下都正常。把这条钉住,免得以后
 * 有人"顺手"把整个 root 环境判成不可用。
 */

const originalGetuid = process.getuid;
const originalIsSandbox = process.env.IS_SANDBOX;
const originalBubblewrap = process.env.CLAUDE_CODE_BUBBLEWRAP;

const asRoot = () => { process.getuid = () => 0; };
const asNormalUser = () => { process.getuid = () => 1000; };

afterEach(() => {
  process.getuid = originalGetuid;
  if (originalIsSandbox === undefined) delete process.env.IS_SANDBOX;
  else process.env.IS_SANDBOX = originalIsSandbox;
  if (originalBubblewrap === undefined) delete process.env.CLAUDE_CODE_BUBBLEWRAP;
  else process.env.CLAUDE_CODE_BUBBLEWRAP = originalBubblewrap;
});

describe('root 下的「跳过权限」档位', () => {
  test('root + bypassPermissions:拦下来并说明原因', () => {
    asRoot();
    delete process.env.IS_SANDBOX;

    const message = describeBypassUnderRoot('bypassPermissions');
    assert.ok(message, '这个组合必须被拦住');
    // 报错里要同时有「为什么」和「怎么办」—— 只说"被拒绝了"等于把人留在原地。
    assert.match(message, /root/);
    assert.match(message, /IS_SANDBOX=1/);
    assert.match(message, /换一个执行档位/);
  });

  test('其余四个档位在 root 下不受影响', () => {
    asRoot();
    delete process.env.IS_SANDBOX;

    for (const mode of ['default', 'plan', 'acceptEdits', 'auto']) {
      assert.equal(describeBypassUnderRoot(mode), null, `${mode} 不该被拦`);
    }
  });

  test('非 root 用户跑 bypassPermissions 没问题', () => {
    asNormalUser();
    delete process.env.IS_SANDBOX;

    assert.equal(describeBypassUnderRoot('bypassPermissions'), null);
  });

  /** 运维显式放行之后就不该再拦 —— 拦了等于这个开关没用。 */
  test('IS_SANDBOX=1 放行', () => {
    asRoot();
    process.env.IS_SANDBOX = '1';

    assert.equal(describeBypassUnderRoot('bypassPermissions'), null);
  });

  test('CLAUDE_CODE_BUBBLEWRAP 同样放行', () => {
    asRoot();
    delete process.env.IS_SANDBOX;
    process.env.CLAUDE_CODE_BUBBLEWRAP = '1';

    assert.equal(describeBypassUnderRoot('bypassPermissions'), null);
  });

  /**
   * `IS_SANDBOX=true` / `yes` 之类**不算数** —— CLI 比的是严格等于字符串 '1'。
   * 这里跟着比严格值,不然 Prism 放行了而 CLI 照样 exit 1,退回到一模一样的
   * 谜之退出码,只是这次还多了一层"Prism 说没问题"的误导。
   */
  test('IS_SANDBOX 只认字符串 1,和 CLI 保持一致', () => {
    asRoot();
    for (const value of ['true', 'yes', '0', '']) {
      process.env.IS_SANDBOX = value;
      assert.ok(
        describeBypassUnderRoot('bypassPermissions'),
        `IS_SANDBOX=${value} 不该被当成放行`,
      );
    }
  });

  /** Windows 上没有 getuid,不能因为拿不到 uid 就把功能判死。 */
  test('没有 getuid 的平台不拦', () => {
    delete process.getuid;
    delete process.env.IS_SANDBOX;

    assert.equal(describeBypassUnderRoot('bypassPermissions'), null);
  });
});
