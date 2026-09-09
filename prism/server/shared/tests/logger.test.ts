import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, test, vi } from 'vitest';

import { createLogger, getLogLevel, parseLogLevel, setLogLevel, DEFAULT_LOG_LEVEL } from '../logger.js';

/**
 * 分级日志。
 *
 * ## 这个文件钉的是三件容易在重构里悄悄丢掉的事
 *
 * 1. **默认档位不能变。** 引入分级的价值在于"需要时能开",不在于"顺手让日志变少"。
 *    哪天有人把默认改成 warn,生产上会突然少掉一大片 info,而没人会立刻发现 ——
 *    只有下次排障时才发现该有的行不在了。
 * 2. **认不出来的档位要吭声。** `PRISM_LOG_LEVEL=verbose` 静默退回默认,意味着
 *    部署方以为自己开了详细日志、实际没开。这种"以为开了"比"没开"更危险。
 * 3. **迁移不能倒回去。** 453 处 `console.*` 换成 logger 之后,只要有人在 server/
 *    里新写一个 `console.log`,那一行就又变成关不掉、没时间、没来源的裸日志。
 *    最后一条测试专门守这个。
 */

const captureLevel = () => getLogLevel();

afterEach(() => {
  setLogLevel(null);          // 忘掉缓存,下次重新读环境变量
  delete process.env.PRISM_LOG_LEVEL;
  vi.restoreAllMocks();
});

describe('分级日志', () => {
  test('默认档位是 info:debug/trace 不输出,info 及以上输出', () => {
    delete process.env.PRISM_LOG_LEVEL;
    setLogLevel(null);
    assert.equal(captureLevel(), DEFAULT_LOG_LEVEL);
    assert.equal(DEFAULT_LOG_LEVEL, 'info', '默认档位改动会让生产上悄悄少掉一片日志');

    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger('t');

    log.debug('不该出现');
    log.trace('也不该出现');
    assert.equal(out.mock.calls.length, 0, 'debug/trace 在默认档位下必须完全不输出');

    log.info('要出现');
    assert.equal(out.mock.calls.length, 1);
    log.warn('要出现');
    log.error('要出现');
    assert.equal(err.mock.calls.length, 2);
  });

  test('warn/error 走 stderr,info/debug 走 stdout', () => {
    setLogLevel('debug');
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger('t');

    log.debug('d'); log.info('i');
    log.warn('w'); log.error('e');

    /*
     * 现在 prism.sh 是 `> log 2>&1` 合并收,所以这条分流不改变现有行为。
     * 它的价值是**留一条能只收要紧那半的路**:`2> err.log` 之后,
     * err.log 里就只有 warn/error,不用在几万行 info 里 grep。
     */
    assert.equal(out.mock.calls.length, 2, 'info/debug 必须走 stdout');
    assert.equal(err.mock.calls.length, 2, 'warn/error 必须走 stderr');
  });

  test('每行都带:时间戳 + 级别 + 来源标签', () => {
    setLogLevel('info');
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('files').info('浏览目录', '/a/b');

    const head = String(out.mock.calls[0]?.[0] ?? '');
    assert.match(
      head,
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} INFO {2}\[files\]$/,
      `每行开头必须是「时间 级别 [来源]」,实际是:${head}`,
    );
    // 参数原样透传,不做字符串拼接 —— 对象仍然由 console 自己格式化
    assert.deepEqual(out.mock.calls[0]?.slice(1), ['浏览目录', '/a/b']);
  });

  test('PRISM_LOG_LEVEL=debug 把降级过的那批打开', () => {
    process.env.PRISM_LOG_LEVEL = 'debug';
    setLogLevel(null);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('t').debug('现在应该看得见');
    assert.equal(out.mock.calls.length, 1, 'debug 档位下 log.debug 必须输出');
  });

  test('silent 连 error 都不输出', () => {
    setLogLevel('silent');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger('t');
    log.error('闭嘴'); log.warn('闭嘴');
    assert.equal(err.mock.calls.length, 0);
  });

  test('认不出来的档位:退回默认,但要吭声', () => {
    assert.equal(parseLogLevel('verbose'), null);
    assert.equal(parseLogLevel('  DEBUG '), 'debug', '大小写和空格要容错');
    assert.equal(parseLogLevel(''), null);
    assert.equal(parseLogLevel(undefined), null);

    process.env.PRISM_LOG_LEVEL = 'verbose';
    setLogLevel(null);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    assert.equal(getLogLevel(), DEFAULT_LOG_LEVEL, '认不出来要退回默认,而不是静音');
    assert.equal(err.mock.calls.length, 1, '静默吞掉会让部署方以为自己开了详细日志');
    assert.match(String(err.mock.calls[0]?.[0] ?? ''), /PRISM_LOG_LEVEL/);
  });

  test('isEnabled 能用来跳过昂贵的拼接', () => {
    setLogLevel('info');
    const log = createLogger('t');
    assert.equal(log.isEnabled('debug'), false);
    assert.equal(log.isEnabled('info'), true);
    assert.equal(log.isEnabled('error'), true);
  });

  test('server/ 里不许再出现裸 console.*(三处例外已登记)', () => {
    /*
     * 守门的。迁移一次是一次性的,**守不住就会慢慢漏回去** —— 每漏一行,
     * 生产日志里就多一行关不掉、没时间、没来源的东西,而这在 diff 里看着完全正常。
     *
     * 三处例外都是有理由的,写在这里而不是写在忽略清单里,是为了让下一个想加例外的人
     * 先看见理由:
     *   - logger.ts 自己:它就是往 console 上写的那一层;
     *   - cli.js:`prism status` 给人看的对齐表格,加时间戳只会毁掉排版;
     *   - load-env.js:整个进程的第一个 import,那时 PRISM_LOG_LEVEL 还没进环境变量。
     */
    const ALLOWED = new Set([
      'server/shared/logger.ts',
      'server/cli.js',
      'server/load-env.js',
    ]);

    const root = process.cwd();
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|js)$/.test(entry.name)) continue;
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (ALLOWED.has(rel)) continue;
        // 测试自己 spy console 是正常的
        if (rel.includes('.test.') || rel.includes('/tests/')) continue;
        const source = fs.readFileSync(full, 'utf8');
        // 只算真的调用,注释里提到 console.log 不算
        for (const line of source.split('\n')) {
          const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
          if (/\bconsole\.(log|warn|error|info|debug)\s*\(/.test(code)) {
            offenders.push(`${rel}: ${line.trim().slice(0, 90)}`);
            break;
          }
        }
      }
    };
    walk(path.join(root, 'server'));

    assert.deepEqual(
      offenders,
      [],
      '这些文件里的日志关不掉、没时间戳、没来源。换成 createLogger(\'<子系统>\'):\n'
        + offenders.join('\n'),
    );
  });
});
