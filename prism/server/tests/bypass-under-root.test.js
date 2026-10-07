import assert from 'node:assert/strict';

import { afterEach, describe, test } from 'vitest';

import { describeBypassUnderRoot } from '../claude-sdk.js';

/**
 * 「跳过权限」档位在 root 下会被 claude CLI 直接拒掉。
 *
 * CLI 拒绝时只以 code 1 退出,原因只写在子进程 stderr 里,聊天和服务端日志都只看到
 * `Claude Code process exited with code 1`;手动跑 `claude -p` 不带 `--dangerously-skip-permissions`,复现不出来。
 * CLI 的条件是:uid === 0 且 `IS_SANDBOX !== '1'` 且没有 `CLAUDE_CODE_BUBBLEWRAP`。这里复刻同一个条件,
 * 在拉起子进程之前就把原因和办法说清楚。
 *
 * 只有这一个档位受影响,其余四个在 root 下都正常,不能把整个 root 环境判成不可用。
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
   * `IS_SANDBOX=true` / `yes` 之类不算数:CLI 比的是严格等于字符串 '1'。
   * 这里也必须比严格值,否则 Prism 放行而 CLI 照样 exit 1,用户只看到一个没有原因的退出码。
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
