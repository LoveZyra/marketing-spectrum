import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test } from 'vitest';

/**
 * `.gitignore` 不许吞掉源码。
 *
 * ## 为什么值得钉一条
 *
 * 不带前导斜杠的模式在任意深度命中:`tasks.json` 会吞掉 i18n 的 `tasks` 翻译命名空间,
 * `tasks/` 会吞掉 `server/modules/tasks/` 与 `src/components/tasks/` 整个功能的实现。
 * 这种误伤没有任何东西报错:文件在磁盘上、在 tar 包里、在跑着的服务里,只是不在
 * git 里,clone 下来的仓库缺功能、甚至构建不过。
 *
 * 负向规则只能堵上已经撞见的那一个洞,所以这里钉的是一般形式:`server/` 与 `src/`
 * 下的源文件一个都不许被忽略。不管谁加了什么形状的规则,只要它误伤源码,这条就会红。
 *
 * ## 为什么这个测试不放在 server/modules/tasks/ 下面
 *
 * 那儿正是容易被吞的目录。测试要是也住在里面,规则误伤时测试文件本身也会跟着从 git
 * 里消失,clone 出来的仓库连这条会报警的测试都没有。守门的不能站在门里面。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 从测试文件往上找到同时有 package.json 与 .gitignore 的那一层。 */
const findRepoRoot = (): string | null => {
  let dir = HERE;
  for (let i = 0; i < 8; i += 1) {
    if (
      fs.existsSync(path.join(dir, 'package.json'))
      && fs.existsSync(path.join(dir, '.gitignore'))
    ) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

const hasGit = (): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.css']);

const collectSourceFiles = (root: string, relativeDir: string): string[] => {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(childRel);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(childRel);
      }
    }
  };
  walk(relativeDir);
  return out;
};

describe('.gitignore 不许吞掉源码', () => {
  const root = findRepoRoot();

  test.skipIf(!root || !hasGit())('server/ 与 src/ 下没有任何源文件被 git 忽略', () => {
    assert.ok(root, '找不到仓库根');

    const sources = [
      ...collectSourceFiles(root, 'server'),
      ...collectSourceFiles(root, 'src'),
    ];
    // 走到这里却一个源文件都没扫到,说明目录布局变了,判据已经失效 —— 那比不通过
    // 更危险(它会一直绿着,却什么都没守)。
    assert.ok(sources.length > 100, `只扫到 ${sources.length} 个源文件,判据可能已失效`);

    // 在一个临时空仓库里用真实的 .gitignore 判,而不是在本仓库里 —— 打出来的
    // tar 包不带 .git,在部署机上解开后照样能跑这条。
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-gitignore-'));
    try {
      execFileSync('git', ['init', '-q', '.'], { cwd: sandbox, stdio: 'ignore' });
      fs.copyFileSync(path.join(root, '.gitignore'), path.join(sandbox, '.gitignore'));
      for (const rel of sources) {
        const target = path.join(sandbox, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '');
      }

      // check-ignore 命中时退出码 0 并打印命中的路径;一个都没命中时退出码 1。
      let ignored = '';
      try {
        ignored = execFileSync('git', ['check-ignore', '--stdin'], {
          cwd: sandbox,
          input: `${sources.join('\n')}\n`,
          encoding: 'utf8',
        });
      } catch (error) {
        const status = (error as { status?: number }).status;
        // 1 = 一个都没命中,正是我们要的。其余退出码是 git 真出错了。
        if (status !== 1) throw error;
      }

      const swallowed = ignored.split('\n').map((line) => line.trim()).filter(Boolean);
      assert.deepEqual(
        swallowed,
        [],
        `这些源文件被 .gitignore 吞掉了,clone 出来的仓库里不会有它们:\n  ${swallowed.join('\n  ')}`,
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test.skipIf(!root || !hasGit())('TaskMaster 自己的状态仍然被忽略', () => {
    assert.ok(root, '找不到仓库根');

    // 上面那条只说"源码不许被吞"。这条守的是另一头:别为了让源码可见,把本该
    // 忽略的工具状态也一起放进来了。
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-gitignore-keep-'));
    try {
      execFileSync('git', ['init', '-q', '.'], { cwd: sandbox, stdio: 'ignore' });
      fs.copyFileSync(path.join(root, '.gitignore'), path.join(sandbox, '.gitignore'));
      const target = path.join(sandbox, '.taskmaster/tasks/tasks.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{}');

      const status = (() => {
        try {
          execFileSync('git', ['check-ignore', '-q', '.taskmaster/tasks/tasks.json'], {
            cwd: sandbox, stdio: 'ignore',
          });
          return 0;
        } catch (error) {
          return (error as { status?: number }).status ?? -1;
        }
      })();

      assert.equal(status, 0, '.taskmaster/tasks/tasks.json 应当仍被忽略');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
