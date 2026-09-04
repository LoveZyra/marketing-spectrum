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
 * 同一个坑踩过两次,两次都是**不带前导斜杠的模式在任意深度命中**:
 *
 * 1. `tasks.json` 吞掉了 i18n 的 `tasks` 翻译命名空间 —— 七个语种里三个的整个
 *    命名空间静默丢失,zh-TW 翻译完了从没提交进去,clone 的人拿到英文 UI;
 * 2. `tasks/` 吞掉了**整个定时任务功能的实现** —— `server/modules/tasks/` 五个
 *    文件加 `src/components/tasks/TasksPage.tsx`,`git log --all` 查这几个路径是
 *    零个提交。clone 下来是一个没有定时任务、而且构建不过的 Prism。
 *
 * 两次都**没有任何东西报错**:文件在磁盘上、在 tar 包里、在跑着的服务里,只是
 * 不在 git 里。我们靠全量 tar 包分发,所以第二个洞躺了很久没被撞到。
 *
 * 第一次的修法是补一条负向规则(`!src/i18n/locales/*'/'tasks.json`)。那只堵上了
 * **已经撞见的**那一个洞 —— 一行之隔的 `tasks/` 原样留着,于是有了第二次。
 * 负向规则的通病就在这:它要求你先撞上,才知道要加哪一条。
 *
 * 所以这里钉的是**一般形式**,而不是那两个具体的模式:`server/` 与 `src/` 下的
 * 源文件,一个都不许被忽略。以后不管谁加了什么形状的规则,只要它误伤源码,这条
 * 就会红。
 *
 * ## 为什么这个测试不放在 server/modules/tasks/ 下面
 *
 * 那儿是被吞的那个目录。测试要是也住在里面,规则一旦被加回来,**测试文件本身也会
 * 跟着从 git 里消失** —— clone 出来的仓库既没有定时任务,也没有那条会报警的测试。
 * 守门的不能站在门里面。
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

    // 在一个临时空仓库里用**真实的 .gitignore** 判,而不是在本仓库里 —— 打出来的
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
