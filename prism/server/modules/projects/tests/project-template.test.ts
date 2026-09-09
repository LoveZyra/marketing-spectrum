import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { createProject } from '@/modules/projects/services/project-management.service.js';
import {
  applyProjectTemplate,
  listProjectTemplates,
  resolveTemplateDir,
  TEMPLATE_MAX_FILES,
} from '@/modules/projects/services/project-template.service.js';

/**
 * 项目模板。
 *
 * ## 这个文件里绝大多数用例是**反向**的
 *
 * "按用户给的 id 把服务器上一棵树复制到另一个位置"是个危险的形状。
 * 正向功能(复制成功)只需要一条用例;剩下的都在验它**拒绝**得对不对:
 *
 * - id 逃不出模板根;
 * - 符号链接一律拒(跟随 = 把 `~/.prism/auth.db` 的内容复制进一个别人看得见的
 *   项目;照抄链接 = 在项目里种一条指向库的路;静默跳过 = 模板作者以为生效了);
 * - 已存在的文件不覆盖(新建项目可能是"复活一条归档路径",里面有真东西);
 * - 文件数/字节封顶。
 *
 * 这个仓库的审计里,最贵的几个洞都是这个形状 —— 一个按用户输入去动文件系统的
 * 操作,少了一道门。所以这里宁可测得啰嗦。
 */

const previousTemplatesDir = process.env.PRISM_PROJECT_TEMPLATES_DIR;
let tempRoot: string | null = null;

afterEach(async () => {
  if (previousTemplatesDir === undefined) delete process.env.PRISM_PROJECT_TEMPLATES_DIR;
  else process.env.PRISM_PROJECT_TEMPLATES_DIR = previousTemplatesDir;
  if (tempRoot) { await fs.rm(tempRoot, { recursive: true, force: true }); tempRoot = null; }
});

/** 造一个模板根,返回 { root, target }。 */
async function setup(): Promise<{ root: string; target: string; outside: string }> {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tpl-'));
  const root = path.join(tempRoot, 'templates');
  const target = path.join(tempRoot, 'newproject');
  const outside = path.join(tempRoot, 'outside');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), '这是不该被复制出去的东西', 'utf8');
  process.env.PRISM_PROJECT_TEMPLATES_DIR = root;
  return { root, target, outside };
}

async function writeTemplate(root: string, id: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, id);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return dir;
}

describe('模板 id 的形状', () => {
  test('逃出模板根的各种写法一律拒', async () => {
    await setup();
    /*
     * 这里不用 "resolve 之后判前缀" 那种写法 —— 那种每加一个新形状都要
     * 重新论证一遍对不对。直接把形状收死:单段、无分隔符、不以点开头。
     */
    for (const bad of [
      '..', '.', '../outside', '../../etc', 'a/b', 'a\\b', '/etc/passwd',
      '', '   ', '.hidden', 'x'.repeat(101),
    ]) {
      assert.throws(
        () => resolveTemplateDir(bad),
        /模板名不合法/,
        `"${bad}" 应当被拒绝 —— 它能走出模板根`,
      );
    }
  });

  test('正常名字放行', async () => {
    const { root } = await setup();
    assert.equal(resolveTemplateDir('python-etl'), path.join(root, 'python-etl'));
    assert.equal(resolveTemplateDir('  spaced  '), path.join(root, 'spaced'));
  });
});

describe('铺模板', () => {
  test('目录树原样复制过去', async () => {
    const { root, target } = await setup();
    await writeTemplate(root, 'etl', {
      'CLAUDE.md': '# 团队约定\n数据在 /data 下。\n',
      'src/main.py': 'print("hi")\n',
      'data/.gitkeep': '',
    });

    const result = await applyProjectTemplate('etl', target);
    assert.equal(result.filesWritten, 3);
    assert.deepEqual(result.filesSkipped, []);
    assert.equal(await fs.readFile(path.join(target, 'CLAUDE.md'), 'utf8'), '# 团队约定\n数据在 /data 下。\n');
    assert.ok((await fs.stat(path.join(target, 'src/main.py'))).isFile(), '子目录也要建出来');
  });

  test('⚠️ 已存在的文件跳过,不覆盖', async () => {
    const { root, target } = await setup();
    await writeTemplate(root, 'etl', { 'CLAUDE.md': '模板的内容\n', 'new.txt': '新文件\n' });
    await fs.writeFile(path.join(target, 'CLAUDE.md'), '用户自己写的,不能被盖掉\n', 'utf8');

    /*
     * 新建项目也可能是"复活一条归档路径" —— 那个目录里有真东西。
     * 拿模板盖上去就是数据丢失,而且是**静默**的数据丢失。
     */
    const result = await applyProjectTemplate('etl', target);
    assert.equal(
      await fs.readFile(path.join(target, 'CLAUDE.md'), 'utf8'),
      '用户自己写的,不能被盖掉\n',
      '模板覆盖了用户已有的文件 —— 这是静默的数据丢失',
    );
    assert.deepEqual(result.filesSkipped, ['CLAUDE.md'], '跳过的要如实报给界面');
    assert.equal(result.filesWritten, 1);
  });

  test('⚠️ 模板里有符号链接:整体拒绝,一个文件都不写', async () => {
    const { root, target, outside } = await setup();
    const dir = await writeTemplate(root, 'evil', { 'README.md': '看起来很正常\n' });
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'secrets.txt'));

    /*
     * 跟随链接 = 把外面的内容复制进一个别人看得见的项目;
     * 照抄链接 = 在项目里种一条指向外面的路。两种都不行。
     *
     * 而且必须**整体拒绝**,不能只跳过那一个:
     *   1. 静默跳过会让模板作者以为那个文件生效了;
     *   2. 部分成功会留下半棵树,而调用方拿到的是"成功"。
     */
    await assert.rejects(
      () => applyProjectTemplate('evil', target),
      /符号链接/,
      '模板里的符号链接必须让整次操作失败',
    );

    assert.equal(
      (await fs.readdir(target)).length, 0,
      '拒绝时目标目录必须干干净净 —— 先全部看一遍再动手,不能留半棵树',
    );
  });

  test('⚠️ 指向目录的符号链接同样拒', async () => {
    const { root, target, outside } = await setup();
    const dir = await writeTemplate(root, 'evil2', { 'a.txt': 'x\n' });
    await fs.symlink(outside, path.join(dir, 'linked-dir'));

    await assert.rejects(() => applyProjectTemplate('evil2', target), /符号链接/);
    assert.equal((await fs.readdir(target)).length, 0);
  });

  test('文件数超限:拒绝,且不留半棵树', async () => {
    const { root, target } = await setup();
    const files: Record<string, string> = {};
    for (let i = 0; i <= TEMPLATE_MAX_FILES + 1; i += 1) files[`f${i}.txt`] = 'x';
    await writeTemplate(root, 'huge', files);

    await assert.rejects(() => applyProjectTemplate('huge', target), /文件数超过/);
    assert.equal((await fs.readdir(target)).length, 0);
  });

  test('模板不存在:404 而不是把空目录当成空模板', async () => {
    const { target } = await setup();
    await assert.rejects(() => applyProjectTemplate('nope', target), /模板不存在/);
  });

  test('模板根自己是符号链接目录:不认', async () => {
    const { root, target, outside } = await setup();
    // 模板根下放一条指向外面的目录软链,名字看着像个正常模板
    await fs.symlink(outside, path.join(root, 'looks-normal'));
    await assert.rejects(() => applyProjectTemplate('looks-normal', target), /模板不存在/);
  });
});

describe('列模板', () => {
  test('列出目录、读元数据、按目录名排序', async () => {
    const { root } = await setup();
    await writeTemplate(root, 'b-plain', { 'a.txt': 'x' });
    await writeTemplate(root, 'a-meta', {
      'a.txt': 'xx',
      '.prism-template.json': JSON.stringify({ name: 'ETL 脚手架', description: '带 CLAUDE.md 和 data/ 目录' }),
    });

    const templates = await listProjectTemplates();
    assert.equal(templates.length, 2);

    /*
     * 按 **id**(目录名)排,不是按显示名。
     *
     * 我第一版按 name 排、并断言 'ETL 脚手架' 在 'b-plain' 前面 —— 结果红了:
     * 这台机器的 ICU 里 `'E'.localeCompare('b') === 1`,E 排在 b 后面。
     * 换台机器可能又反过来。所以改成按目录名排 + 写死 locale:
     * 运维在服务器上看到的顺序和界面上的一致,而且两台机器上一样。
     */
    assert.deepEqual(templates.map((entry) => entry.id), ['a-meta', 'b-plain']);
    assert.equal(templates[0]!.name, 'ETL 脚手架');
    assert.equal(templates[0]!.description, '带 CLAUDE.md 和 data/ 目录');
    assert.equal(templates[0]!.fileCount, 1, '.prism-template.json 自己不算模板内容');
    assert.equal(templates[1]!.name, 'b-plain', '没有元数据就用目录名');
  });

  test('数字后缀按数值排,不按字典序', async () => {
    const { root } = await setup();
    for (const id of ['tpl10', 'tpl2', 'tpl1']) await writeTemplate(root, id, { 'a.txt': 'x' });
    const templates = await listProjectTemplates();
    assert.deepEqual(templates.map((entry) => entry.id), ['tpl1', 'tpl2', 'tpl10']);
  });

  test('一个坏模板不该让整个列表挂掉', async () => {
    const { root, outside } = await setup();
    await writeTemplate(root, 'good', { 'a.txt': 'x' });
    const badDir = await writeTemplate(root, 'bad', { 'a.txt': 'x' });
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(badDir, 'link.txt'));

    /*
     * 坏模板要从列表里消失(免得有人选了它再失败),但不能让整个接口 500 ——
     * 那样一个手滑的软链就会让所有人都建不了项目。日志里会有一行说明是哪个。
     */
    const templates = await listProjectTemplates();
    assert.deepEqual(templates.map((entry) => entry.id), ['good']);
  });

  test('模板根不存在:空数组,不是报错', async () => {
    process.env.PRISM_PROJECT_TEMPLATES_DIR = '/nonexistent-templates-dir-xyz';
    assert.deepEqual(await listProjectTemplates(), [], '没配模板不是错误');
  });
});

describe('⚠️ 模板失败不能留下幽灵项目', () => {
  /*
   * 这一组钉的是探针里真抓到的一个 bug —— **我自己在这一轮引入的**。
   *
   * 第一版把铺模板放在 `createProject` 的**末尾**,于是
   * `templateId: "../evil"` 走的是:
   *   建目录 → 项目行落库 → 铺模板时才发现名字不合法 → 抛 → 接口回 success:false
   *
   * 用户被告知"创建失败",而项目**已经在库里了**,下次刷新自己出现在侧栏。
   * 探针上连打五个非法请求 = 五个幽灵项目。
   *
   * 修法是把校验整体提到函数最前面(prepare / write 拆开),而不是"失败了再回滚"
   * —— 回滚本身也会失败,而且"复活归档路径"那种情形根本不该回滚。
   *
   * ## 为什么注入 validatePath
   *
   * 真的 `validateWorkspacePath` 把 `/tmp` 列为禁地,而 `WORKSPACES_ROOT` 是
   * **模块加载时**读的常量 —— 测试里改 `process.env` 已经晚了。
   * 这里要测的是"模板校验发生在建东西之前"这个**顺序**,和路径策略无关
   * (那条有它自己的测试)。所以把路径校验注入成放行,让被测的东西露出来。
   */
  const previousDb = process.env.DATABASE_PATH;

  afterEach(() => {
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
  });

  /** 除了路径校验放行,其余全用真实实现 —— 要断言的正是"库里有没有留下行"。 */
  const permissivePathDeps = {
    validatePath: async (projectPath: string) => ({ valid: true as const, resolvedPath: projectPath }),
    ensureWorkspaceDirectory: async (projectPath: string): Promise<void> => {
      await fs.mkdir(projectPath, { recursive: true });
    },
    persistProjectPath: (
      projectPath: string,
      customName: string | null,
      ownerUserId: number | null,
      visibility: 'public' | null,
    ) => projectsDb.createProjectPath(projectPath, customName, ownerUserId, visibility),
    getProjectByPath: (projectPath: string) => projectsDb.getProjectPath(projectPath),
    setProjectShares: (projectId: string, userIds: number[], grantedBy: number | null) =>
      projectsDb.setProjectShares(projectId, userIds, grantedBy),
  };

  async function withProjectDb(): Promise<string> {
    const { root } = await setup();
    const workspace = path.join(path.dirname(root), 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    closeConnection();
    process.env.DATABASE_PATH = path.join(path.dirname(root), 'auth.db');
    await initializeDatabase();
    return workspace;
  }

  for (const [label, templateId, expected] of [
    ['名字非法', '../evil', /模板名不合法/],
    ['模板不存在', 'nope', /模板不存在/],
  ] as const) {
    test(`${label}:目录不建、项目行不落库`, async () => {
      const workspace = await withProjectDb();
      const projectPath = path.join(workspace, 'ghost');

      await assert.rejects(
        () => createProject({ projectPath, templateId }, permissivePathDeps),
        expected,
      );

      assert.equal(
        await fs.stat(projectPath).then(() => true).catch(() => false), false,
        '模板校验失败时不该建出目录',
      );
      assert.equal(
        projectsDb.getProjectPath(projectPath), null,
        '模板校验失败时不该留下项目行 —— 接口说"失败"而侧栏里有,是最难查的那种不一致',
      );
    });
  }

  test('模板里有符号链接:同样什么都不留', async () => {
    const workspace = await withProjectDb();
    const root = process.env.PRISM_PROJECT_TEMPLATES_DIR!;
    const dir = await writeTemplate(root, 'evil', { 'a.txt': 'x' });
    await fs.symlink(path.join(path.dirname(root), 'outside', 'secret.txt'), path.join(dir, 'link.txt'));

    const projectPath = path.join(workspace, 'ghost2');
    await assert.rejects(
      () => createProject({ projectPath, templateId: 'evil' }, permissivePathDeps),
      /符号链接/,
    );
    assert.equal(await fs.stat(projectPath).then(() => true).catch(() => false), false);
    assert.equal(projectsDb.getProjectPath(projectPath), null);
  });

  test('正常模板:项目建出来,模板也铺进去了', async () => {
    const workspace = await withProjectDb();
    const root = process.env.PRISM_PROJECT_TEMPLATES_DIR!;
    await writeTemplate(root, 'ok', { 'CLAUDE.md': '# 约定\n', 'src/main.py': 'x\n' });

    const projectPath = path.join(workspace, 'real');
    const result = await createProject({ projectPath, templateId: 'ok' }, permissivePathDeps);

    assert.equal(result.template?.filesWritten, 2);
    assert.ok(projectsDb.getProjectPath(projectPath), '项目行要在');
    assert.equal(await fs.readFile(path.join(projectPath, 'CLAUDE.md'), 'utf8'), '# 约定\n');
  });
});
