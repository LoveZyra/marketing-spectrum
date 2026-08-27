import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { ClaudeSkillsProvider } from '@/modules/providers/list/claude/claude-skills.provider.js';

/**
 * F13:界面上的卸载入口。
 *
 * 服务端的 DELETE 一直都在,缺的是"哪些技能**可以**被卸载"这条信息 ——
 * 之前列表里的技能只有 sourcePath,前端要么从路径里猜目录名(猜错就是画出一个
 * 点了会失败、或者更糟、删错东西的按钮),要么干脆不给入口(于是装错只能登
 * 服务器删目录)。
 *
 * 现在服务端只给**能安全卸载的那些**带 `directoryName`:用户级、直接躺在受管
 * 根目录下一层。这个测试钉的就是这条判据。
 */
const previousHome = process.env.HOME;
let tempHome: string | null = null;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

async function seedSkill(relativeDir: string, name: string): Promise<void> {
  const dir = path.join(tempHome!, '.claude', 'skills', relativeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n正文\n`,
  );
}

describe('技能列表里的可卸载标记', () => {
  test('受管根目录下一层的技能带 directoryName;更深一层的不带', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'skills-dirname-'));
    process.env.HOME = tempHome;

    await seedSkill('tidy-notes', 'tidy-notes');
    await seedSkill(path.join('nested', 'deeper'), 'deeper');

    const skills = await new ClaudeSkillsProvider().listSkills({});
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    assert.equal(byName.get('tidy-notes')?.directoryName, 'tidy-notes',
      '直接躺在受管根目录下一层 —— 删这个目录就是删这个技能,安全');
    assert.equal(byName.get('deeper')?.directoryName, undefined,
      '再深一层时"目录 = 技能"不再成立,不该给卸载入口');
  });

  test('没有任何技能时不炸', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'skills-dirname-empty-'));
    process.env.HOME = tempHome;
    assert.deepEqual(await new ClaudeSkillsProvider().listSkills({}), []);
  });
});
