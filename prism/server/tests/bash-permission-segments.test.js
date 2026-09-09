import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import { splitShellSegments } from '../claude-sdk.js';

/**
 * fj:「记住这条 Bash 权限」不许把复合命令一起放行。
 *
 * 判据原来是 `command.startsWith(allowedPrefix)`。用户批准一次 `git status`
 * 生成条目 `Bash(git status:*)`,此后 `git status; rm -rf x` 以那个前缀开头 ——
 * **自动放行,确认框不再出现**。也就是「我允许过 git status」被读成了
 * 「我允许过任意 shell」。
 *
 * 这一组钉拆分本身;放行判定改成"每一段都要命中"。
 */
describe('fj:shell 子命令拆分', () => {
  it('分号、&&、||、管道、后台符、换行都是"再跑一条"的入口', () => {
    assert.deepEqual(splitShellSegments('git status; rm -rf x'), ['git status', 'rm -rf x']);
    assert.deepEqual(splitShellSegments('git status && curl evil'), ['git status', 'curl evil']);
    assert.deepEqual(splitShellSegments('git status || nc -e sh'), ['git status', 'nc -e sh']);
    assert.deepEqual(splitShellSegments('git status | sh'), ['git status', 'sh']);
    assert.deepEqual(splitShellSegments('git status & wget x'), ['git status', 'wget x']);
    assert.deepEqual(splitShellSegments('git status\nrm -rf x'), ['git status', 'rm -rf x']);
  });

  it('引号里的同名字符不算分隔 —— 否则正常命令会被拆碎、白弹确认框', () => {
    assert.deepEqual(splitShellSegments('echo "a; b"'), ['echo "a; b"']);
    assert.deepEqual(splitShellSegments("echo 'x && y'"), ["echo 'x && y'"]);
    assert.deepEqual(splitShellSegments('echo "a \\" ; b"'), ['echo "a \\" ; b"']);
  });

  it('空段不参与判定(结尾分号、连续分号)', () => {
    assert.deepEqual(splitShellSegments('git status;'), ['git status']);
    assert.deepEqual(splitShellSegments('git status;;ls'), ['git status', 'ls']);
  });

  it('单条命令原样返回', () => {
    assert.deepEqual(splitShellSegments('npm run build'), ['npm run build']);
  });
});
