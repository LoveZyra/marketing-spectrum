import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test } from 'vitest';

import {
  bumpKind,
  checkBump,
  compareVersions,
  depsFingerprint,
  isValidReleaseDate,
  manifestLines,
  md5,
  parseVersion,
  pickPreviousTag,
  releaseDate,
} from '../../scripts/release-lib.mjs';
import { formatReleaseLabel, isReleaseVersion, pickReleaseMeta } from '../../shared/releaseInfo.ts';
import { readReleaseInfo } from '../shared/release-info.ts';

/**
 * 版本号只用「主.次.修」三个数字,按部署代价跳号(见项目文档《版本号规范》)。
 * 这里钉住:号的格式、跳号规则(依赖 / schema / migrations 变了至少跳次版本号)、依赖指纹不受根版本号影响、
 * 清单排序与 `LC_ALL=C sort` 一致、运行中的版本信息怎么读。
 */

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('版本号格式', () => {
  test('只认三段纯数字,不带前导零、后缀、字母代号', () => {
    assert.deepEqual(parseVersion('2.0.0'), [2, 0, 0]);
    assert.deepEqual(parseVersion('10.11.12'), [10, 11, 12]);
    for (const bad of ['2.0', '2.0.0.1', 'v2.0.0', '02.0.0', '2.0.0-rc.1', '2.0.0+hq', 'hq', '', null, undefined]) {
      assert.equal(parseVersion(bad), null, String(bad));
      assert.equal(isReleaseVersion(bad), false, String(bad));
    }
    assert.equal(isReleaseVersion('2.0.0'), true);
  });

  test('按数字比,不按字符串比(2.10.0 > 2.9.0)', () => {
    assert.equal(compareVersions('2.10.0', '2.9.0'), 1);
    assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
    assert.equal(compareVersions('1.99.99', '2.0.0'), -1);
  });

  test('package.json 与 package-lock.json 根上的版本号一致,且是合法的三段数字', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    assert.ok(isReleaseVersion(pkg.version), pkg.version);
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
  });
});

describe('跳号规则', () => {
  test('跳的是哪一位;跳了某一位后面要归零', () => {
    assert.equal(bumpKind(null, '2.0.0'), 'initial');
    assert.equal(bumpKind('2.0.0', '3.0.0'), 'major');
    assert.equal(bumpKind('2.0.0', '2.1.0'), 'minor');
    assert.equal(bumpKind('2.1.0', '2.1.1'), 'patch');
    assert.equal(bumpKind('2.1.1', '2.1.1'), 'same');
    assert.equal(bumpKind('2.1.1', '2.0.9'), 'lower');
    assert.equal(bumpKind('2.1.1', '2.2.1'), 'irregular');
    assert.equal(bumpKind('2.1.1', '3.1.0'), 'irregular');
  });

  test('依赖 / schema / migrations 变了只跳修订号 → 拒;跳次版本号或主版本号 → 过', () => {
    const none = { deps: false, schema: false, migrations: false };
    assert.equal(checkBump({ previous: '2.0.0', next: '2.0.1', changed: none }).ok, true);
    for (const key of ['deps', 'schema', 'migrations']) {
      const changed = { ...none, [key]: true };
      const patch = checkBump({ previous: '2.0.0', next: '2.0.1', changed });
      assert.equal(patch.ok, false, key);
      assert.equal(patch.required, 'minor');
      assert.match(patch.problems.join('\n'), /至少要跳次版本号/);
      assert.equal(checkBump({ previous: '2.0.0', next: '2.1.0', changed }).ok, true, key);
      assert.equal(checkBump({ previous: '2.0.0', next: '3.0.0', changed }).ok, true, key);
    }
  });

  test('上一版 = 已合入标签里版本号最大的(热修 v2.0.1 合回主线后,主线 2.1.1 仍和 2.1.0 比)', () => {
    assert.equal(pickPreviousTag(['v2.0.0', 'v2.1.0', 'v2.0.1'], '2.1.1'), 'v2.1.0');
    // 热修分支上只合进了 v2.0.0
    assert.equal(pickPreviousTag(['v2.0.0'], '2.0.1'), 'v2.0.0');
    // 重打同一版:自己的标签不算;不合规的标签忽略;按数字比(2.10.0 > 2.9.0)
    assert.equal(pickPreviousTag(['v2.0.0', 'v2.1.0'], '2.1.0'), 'v2.0.0');
    assert.equal(pickPreviousTag(['v1.0.0-rc.1', 'vfoo', 'release-3', 'v2.9.0', 'v2.10.0'], '2.10.1'), 'v2.10.0');
    assert.equal(pickPreviousTag([], '2.0.0'), null);
    assert.equal(pickPreviousTag(['v2.0.0'], '2.0.0'), null);
  });

  test('发布日期要是真实的日子', () => {
    assert.equal(isValidReleaseDate('20261005'), true);
    assert.equal(isValidReleaseDate('20240229'), true);
    for (const bad of ['20261399', '20250229', '2026105', 'abcdefgh', undefined]) assert.equal(isValidReleaseDate(bad), false, String(bad));
  });

  test('号不复用、不倒退、第一版不比', () => {
    assert.equal(checkBump({ previous: '2.0.0', next: '2.0.0', changed: null }).ok, false);
    assert.equal(checkBump({ previous: '2.1.0', next: '2.0.5', changed: null }).ok, false);
    assert.equal(checkBump({ previous: null, next: '2.0.0', changed: null }).ok, true);
    assert.equal(checkBump({ previous: null, next: 'hq', changed: null }).ok, false);
  });
});

describe('依赖指纹', () => {
  test('只改根上的版本号 → 指纹不变;改了依赖 → 指纹变', () => {
    const lock = (rootVersion, dep) => JSON.stringify({
      name: 'prism', version: rootVersion, lockfileVersion: 3, requires: true,
      packages: { '': { name: 'prism', version: rootVersion }, 'node_modules/x': { version: dep } },
    }, null, 2);
    assert.equal(depsFingerprint(lock('1.0.0', '1.2.3')), depsFingerprint(lock('2.0.0', '1.2.3')));
    assert.notEqual(depsFingerprint(lock('2.0.0', '1.2.3')), depsFingerprint(lock('2.0.0', '1.2.4')));
  });

  test('与部署文档里那条 node -e 一行命令算出来的一样', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-fp-'));
    try {
      const text = readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8');
      writeFileSync(path.join(dir, 'package-lock.json'), text);
      const oneLiner = "const l=require('./package-lock.json');delete l.version;if(l.packages&&l.packages[''])delete l.packages[''].version;console.log(require('crypto').createHash('md5').update(JSON.stringify(l)).digest('hex'))";
      const result = spawnSync(process.execPath, ['-e', oneLiner], { cwd: dir, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), depsFingerprint(text));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('清单', () => {
  test('排序与 LC_ALL=C sort 一致,格式与 md5sum 一致', () => {
    const rels = ['src/b.ts', 'README.md', '.env.example', 'src/B.ts', '新服务器部署说明.md', 'src/a/b.ts', 'src-x/a.ts', 'Z.md'];
    const entries = rels.map((rel) => ({ rel, content: Buffer.from(`内容 ${rel}`) }));
    const lines = manifestLines(entries);
    const sorted = spawnSync('sort', [], { input: rels.map((rel) => `./${rel}`).join('\n'), env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8' });
    assert.deepEqual(lines.map((line) => line.slice(34)), sorted.stdout.trim().split('\n'));
    assert.equal(lines.find((line) => line.endsWith('./README.md')), `${md5(Buffer.from('内容 README.md'))}  ./README.md`);
  });

  test('发布日期默认按北京时间', () => {
    assert.equal(releaseDate(new Date('2026-09-30T17:30:00Z'), 'Asia/Shanghai'), '20261001');
    assert.equal(releaseDate(new Date('2026-09-30T17:30:00Z'), 'UTC'), '20260930');
  });
});

describe('运行中的版本信息', () => {
  test('标签:有日期和提交号就带上,缺的省掉;没有版本号返回 null', () => {
    assert.equal(formatReleaseLabel({ version: '2.0.0', date: '2026-10-01', commit: '3c84d6c' }), 'v2.0.0 · 2026-10-01 · 3c84d6c');
    assert.equal(formatReleaseLabel({ version: '2.0.0', date: null, commit: null }), 'v2.0.0');
    assert.equal(formatReleaseLabel({ version: null }), null);
  });

  test('RELEASE.json 的版本号对不上 package.json → 整份不认;字段格式不对的丢掉', () => {
    const raw = { version: '2.0.0', date: '2026-10-01', commit: '3c84d6c' };
    assert.deepEqual(pickReleaseMeta(raw, '2.0.0'), { date: '2026-10-01', commit: '3c84d6c' });
    assert.deepEqual(pickReleaseMeta(raw, '2.0.1'), { date: null, commit: null });
    assert.deepEqual(pickReleaseMeta({ version: '2.0.0', date: '10/01', commit: 'zz' }, '2.0.0'), { date: null, commit: null });
    assert.deepEqual(pickReleaseMeta(null, '2.0.0'), { date: null, commit: null });
  });

  test('readReleaseInfo:读 package.json + RELEASE.json;没有 RELEASE.json(从源码跑)只有版本号', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-info-'));
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'prism', version: '2.0.0' }));
      assert.deepEqual(readReleaseInfo(dir), { version: '2.0.0', date: null, commit: null, label: 'v2.0.0' });
      writeFileSync(path.join(dir, 'RELEASE.json'), JSON.stringify({ version: '2.0.0', date: '2026-10-01', commit: 'abcdef1' }));
      assert.equal(readReleaseInfo(dir).label, 'v2.0.0 · 2026-10-01 · abcdef1');
      // 上一个包留下的 RELEASE.json(版本号对不上)不认
      writeFileSync(path.join(dir, 'RELEASE.json'), JSON.stringify({ version: '1.9.0', date: '2026-09-01', commit: 'abcdef1' }));
      assert.equal(readReleaseInfo(dir).label, 'v2.0.0');
      rmSync(path.join(dir, 'package.json'));
      assert.deepEqual(readReleaseInfo(dir), { version: null, date: null, commit: null, label: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
