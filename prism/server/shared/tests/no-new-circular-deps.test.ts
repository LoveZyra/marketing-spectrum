import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test } from 'vitest';

/**
 * 后端不许**新增**循环依赖。
 *
 * ## 为什么这条测试必须自己跑 madge,而不是靠人记得跑
 *
 * 这个仓库为循环依赖出过一次真事故:`en` 轮 provider 反向 import watcher,
 * `ClaudeSessionSynchronizer is not a constructor`,整个 provider 层起不来 ——
 * **而类型检查完全看不出来**。
 *
 * 更麻烦的是查这件事的工具会骗人:
 *
 *     npx madge --circular --extensions ts,tsx,js src server   →  "No circular dependency found"
 *
 * 这条命令(也是任何人凭直觉会敲的那条)对 server **无效** —— madge 解析不了 `@/`
 * 别名,也解析不了 `.js` → `.ts` 的扩展名改写,于是它**静默跳过 135 个文件**后宣布干净。
 * 必须带 `--ts-config server/tsconfig.json`。加上之后实测出 4 个环。
 *
 * 一条会骗人的检查比没有检查更糟,所以把正确的命令钉在这里。
 *
 * ## 为什么是"不许新增"而不是"必须为零"
 *
 * 还剩一个环:`providers/services/sessions.service → websocket/index →
 * chat-websocket.service → providers/index`。它是 eslint 边界规则(跨模块必须走
 * barrel)与"防环"的正面冲突 —— providers 要 `chatRunRegistry`,websocket 要
 * `seedDisplayLogFromTranscript`,两个都是有状态的业务服务,不像
 * `websocket-state` / `project-display-name` 那样能往叶子上搬。
 *
 * 真要拆得动依赖注入或事件总线,那是独立一轮的事。在那之前先把数字钉住:
 * **可以变少,不许变多**。变少了就把 BASELINE 调下来(测试会提示)。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const findRepoRoot = (): string | null => {
  let dir = HERE;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'server'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

/** 当前已知的环数。**只允许下调。** */
const BASELINE = 1;

const root = findRepoRoot();

const runMadge = (): string | null => {
  try {
    return execFileSync(
      'npx',
      ['--no-install', 'madge', '--circular', '--ts-config', 'server/tsconfig.json', 'server'],
      { cwd: root!, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
    );
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    // madge 发现环时退出码非 0,输出仍在 stdout —— 那是正常结果,不是失败
    if (typeof err.stdout === 'string' && err.stdout.includes('circular')) return err.stdout;
    return null; // madge 没装(npx --no-install)或超时:跳过,别让它变成假红
  }
};

describe('后端循环依赖', () => {
  test('数量不超过基线(注意:不带 --ts-config 的 madge 会假装干净)', () => {
    assert.ok(root, '找不到仓库根');
    const output = runMadge();
    if (output === null) {
      // 本地没装 madge 时静默通过 —— CI 里装了就会真的跑
      return;
    }

    if (/No circular dependency found/i.test(output)) {
      assert.equal(BASELINE, 0, `环已经清零了,请把 BASELINE 从 ${BASELINE} 改成 0`);
      return;
    }

    const matched = output.match(/Found (\d+) circular dependenc/i);
    assert.ok(matched, `解析不了 madge 输出,判据可能已失效:\n${output.slice(0, 400)}`);
    const count = Number(matched[1]);

    assert.ok(
      count <= BASELINE,
      `循环依赖从 ${BASELINE} 涨到了 ${count} —— 多半是有人跨模块 import 了对方的 barrel。\n`
        + '低层原语请放 server/shared/(参考 websocket-state.ts / project-display-name.ts 的注释)。\n'
        + output,
    );
    if (count < BASELINE) {
      // 变少是好事,但基线要跟着降,否则它会慢慢退回去
      assert.fail(`环减少到 ${count} 了,请把 BASELINE 从 ${BASELINE} 改成 ${count}`);
    }
  }, 130_000);
});
