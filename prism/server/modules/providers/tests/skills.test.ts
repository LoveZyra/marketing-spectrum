import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { providerSkillsService } from '@/modules/providers/services/skills.service.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const writeSkill = async (
  skillsRoot: string,
  directoryName: string,
  name: string,
  description: string,
): Promise<string> => {
  const skillDir = path.join(skillsRoot, directoryName);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(
    skillPath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n`,
    'utf8',
  );
  return skillPath;
};

const writeClaudePluginManifest = async (
  installPath: string,
  name: string,
): Promise<void> => {
  const pluginConfigDir = path.join(installPath, '.claude-plugin');
  await fs.mkdir(pluginConfigDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginConfigDir, 'plugin.json'),
    JSON.stringify(
      {
        name,
        version: '0.1.0',
        description: `${name} test plugin`,
      },
      null,
      2,
    ),
    'utf8',
  );
};

const writeClaudePluginCommand = async (
  commandsRoot: string,
  commandName: string,
  description: string,
): Promise<string> => {
  await fs.mkdir(commandsRoot, { recursive: true });
  const commandPath = path.join(commandsRoot, `${commandName}.md`);
  await fs.writeFile(
    commandPath,
    `---\ndescription: ${description}\nargument-hint: 'test args'\n---\n\nCommand body.\n`,
    'utf8',
  );
  return commandPath;
};

/**
 * This test covers Claude user/project skill folders plus plugin discovery from
 * installed plugin command files and fallback plugin skill files.
 */
test('providerSkillsService lists claude user, project, and enabled plugin skills', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-claude-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const commandPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'notion-plugin',
    'notion',
    'abc123',
  );
  const skillPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'anthropic-agent-skills',
    'example-skills',
    'def456',
  );
  const disabledPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'disabled-marketplace',
    'disabled-skills',
    'ghi789',
  );
  const emptyIdPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'invalid-empty-plugin',
    'empty',
    '000',
  );
  const atIdPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'invalid-at-plugin',
    'at',
    '000',
  );
  const siblingSkillPluginPath = path.join(path.dirname(skillPluginInstallPath), 'legacy777');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await writeSkill(
      path.join(tempRoot, '.claude', 'skills'),
      'claude-user-dir',
      'claude-user',
      'Claude user skill',
    );
    await writeSkill(
      path.join(workspacePath, '.claude', 'skills'),
      'claude-project-dir',
      'claude-project',
      'Claude project skill',
    );
    await writeClaudePluginManifest(commandPluginInstallPath, 'Notion');
    await writeClaudePluginCommand(
      path.join(commandPluginInstallPath, 'commands'),
      'insert-row',
      'Insert a Notion database row',
    );
    await writeSkill(
      path.join(commandPluginInstallPath, 'skills'),
      'ignored-command-plugin-skill-dir',
      'ignored-command-plugin-skill',
      'Command plugin fallback skill should be ignored',
    );
    await writeClaudePluginManifest(skillPluginInstallPath, 'ExampleSkills');
    await writeSkill(
      path.join(skillPluginInstallPath, 'skills'),
      'claude-plugin-dir',
      'claude-plugin',
      'Claude plugin skill',
    );
    await writeSkill(
      path.join(skillPluginInstallPath, 'skills'),
      'claude-plugin-second-dir',
      'claude-plugin-second',
      'Second Claude plugin skill',
    );
    await writeSkill(
      path.join(skillPluginInstallPath, 'skills', 'nested', 'collection'),
      'claude-plugin-nested-dir',
      'claude-plugin-nested',
      'Nested Claude plugin skill',
    );
    await writeSkill(
      path.join(siblingSkillPluginPath, 'skills'),
      'claude-plugin-sibling-dir',
      'claude-plugin-sibling',
      'Sibling Claude plugin skill',
    );
    await writeClaudePluginManifest(disabledPluginInstallPath, 'DisabledSkills');
    await writeClaudePluginCommand(
      path.join(disabledPluginInstallPath, 'commands'),
      'disabled-command',
      'Disabled plugin command',
    );
    await writeClaudePluginCommand(
      path.join(emptyIdPluginInstallPath, 'commands'),
      'invalid-empty-command',
      'Invalid empty id command',
    );
    await writeClaudePluginCommand(
      path.join(atIdPluginInstallPath, 'commands'),
      'invalid-at-command',
      'Invalid at id command',
    );
    await writeSkill(
      path.join(
        disabledPluginInstallPath,
        'skills',
      ),
      'disabled-plugin-dir',
      'disabled-plugin',
      'Disabled plugin skill',
    );

    await fs.writeFile(
      path.join(tempRoot, '.claude', 'settings.json'),
      JSON.stringify(
        {
          enabledPlugins: {
            '': true,
            '@': true,
            'notion@notion-marketplace': true,
            'example-skills@anthropic-agent-skills': true,
            'disabled-skills@disabled-marketplace': false,
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await fs.writeFile(
      path.join(tempRoot, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify(
        {
          version: 2,
          plugins: {
            '': [
              {
                scope: 'user',
                installPath: emptyIdPluginInstallPath,
                version: '000',
              },
            ],
            '@': [
              {
                scope: 'user',
                installPath: atIdPluginInstallPath,
                version: '000',
              },
            ],
            'notion@notion-marketplace': [
              {
                scope: 'user',
                installPath: commandPluginInstallPath,
                version: 'abc123',
              },
            ],
            'example-skills@anthropic-agent-skills': [
              {
                scope: 'user',
                installPath: skillPluginInstallPath,
                version: 'def456',
              },
            ],
            'disabled-skills@disabled-marketplace': [
              {
                scope: 'user',
                installPath: disabledPluginInstallPath,
                version: 'ghi789',
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const skills = await providerSkillsService.listProviderSkills('claude', { workspacePath });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    assert.equal(byName.get('claude-user')?.scope, 'user');
    assert.equal(byName.get('claude-user')?.command, '/claude-user');
    assert.equal(byName.get('claude-project')?.scope, 'project');
    assert.equal(byName.get('claude-project')?.command, '/claude-project');

    const pluginCommand = byName.get('insert-row');
    assert.equal(pluginCommand?.scope, 'plugin');
    assert.equal(pluginCommand?.pluginName, 'Notion');
    assert.equal(pluginCommand?.pluginId, 'notion@notion-marketplace');
    assert.equal(pluginCommand?.command, '/Notion:insert-row');
    assert.equal(pluginCommand?.description, 'Insert a Notion database row');
    assert.match(pluginCommand?.sourcePath ?? '', /commands[\\/]insert-row\.md$/);
    assert.equal(byName.has('ignored-command-plugin-skill'), false);

    const pluginSkill = byName.get('claude-plugin');
    assert.equal(pluginSkill?.scope, 'plugin');
    assert.equal(pluginSkill?.pluginName, 'ExampleSkills');
    assert.equal(pluginSkill?.pluginId, 'example-skills@anthropic-agent-skills');
    assert.equal(pluginSkill?.command, '/ExampleSkills:claude-plugin');
    assert.equal(pluginSkill?.description, 'Claude plugin skill');
    assert.match(
      pluginSkill?.sourcePath ?? '',
      /cache[\\/]anthropic-agent-skills[\\/]example-skills[\\/]def456[\\/]skills[\\/]/,
    );

    const secondPluginSkill = byName.get('claude-plugin-second');
    assert.equal(secondPluginSkill?.scope, 'plugin');
    assert.equal(secondPluginSkill?.command, '/ExampleSkills:claude-plugin-second');

    const nestedPluginSkill = byName.get('claude-plugin-nested');
    assert.equal(nestedPluginSkill?.scope, 'plugin');
    assert.equal(nestedPluginSkill?.command, '/ExampleSkills:claude-plugin-nested');
    assert.equal(nestedPluginSkill?.description, 'Nested Claude plugin skill');

    const siblingPluginSkill = byName.get('claude-plugin-sibling');
    assert.equal(siblingPluginSkill?.scope, 'plugin');
    assert.equal(siblingPluginSkill?.pluginName, 'example-skills');
    assert.equal(siblingPluginSkill?.command, '/example-skills:claude-plugin-sibling');
    assert.equal(siblingPluginSkill?.description, 'Sibling Claude plugin skill');
    assert.equal(byName.has('disabled-command'), false);
    assert.equal(byName.has('disabled-plugin'), false);
    assert.equal(byName.has('invalid-empty-command'), false);
    assert.equal(byName.has('invalid-at-command'), false);
    assert.equal(skills.some((skill) => skill.command.startsWith('/:')), false);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Managed global skill creation, replacement, and removal.
 *
 * Prism supports Claude Code only, so this exercises the whole managed-skill
 * lifecycle against the Claude provider: creation with supporting files,
 * name fallback when frontmatter omits `name`, replacement wiping the previous
 * directory contents, all-or-nothing batch validation, removal, and rejection
 * of supporting paths that escape the skill directory.
 */
test('providerSkillsService creates, replaces, and removes managed claude skills', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-create-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // --- create, including a supporting file ---
    const createdSkills = await providerSkillsService.addProviderSkills('claude', {
      entries: [
        {
          directoryName: 'uploaded-claude-folder',
          fileName: 'SKILL.md',
          content: '---\nname: claude-global\ndescription: Claude global skill\n---\n\nClaude body.\n',
          files: [
            {
              relativePath: 'scripts/run.js',
              content: Buffer.from('console.log("claude skill");\n').toString('base64'),
              encoding: 'base64',
            },
          ],
        },
      ],
    });
    const createdSkill = createdSkills[0];
    assert.ok(createdSkill);
    assert.equal(createdSkill.command, '/claude-global');
    assert.equal(
      createdSkill.sourcePath.endsWith(path.join('.claude', 'skills', 'uploaded-claude-folder', 'SKILL.md')),
      true,
    );
    assert.match(await fs.readFile(createdSkill.sourcePath, 'utf8'), /Claude body\./);
    assert.equal(
      await fs.readFile(path.join(path.dirname(createdSkill.sourcePath), 'scripts', 'run.js'), 'utf8'),
      'console.log("claude skill");\n',
    );

    // --- name falls back to a normalized file name when frontmatter omits it ---
    const fallbackNamedSkills = await providerSkillsService.addProviderSkills('claude', {
      entries: [
        {
          fileName: 'fallback / skill.md',
          content: '---\ndescription: Normalized fallback skill\n---\n\nFallback body.\n',
        },
      ],
    });
    const fallbackNamedSkill = fallbackNamedSkills[0];
    assert.ok(fallbackNamedSkill);
    assert.equal(fallbackNamedSkill.name, 'fallback-skill');
    assert.equal(fallbackNamedSkill.command, '/fallback-skill');
    assert.equal(
      fallbackNamedSkill.sourcePath.endsWith(path.join('.claude', 'skills', 'fallback-skill', 'SKILL.md')),
      true,
    );

    // --- replacing a directory must not leave the previous supporting files behind ---
    const replacedSkills = await providerSkillsService.addProviderSkills('claude', {
      entries: [
        {
          directoryName: 'uploaded-claude-folder',
          content: '---\nname: replacement\ndescription: Replacement skill\n---\n\nReplacement body.\n',
        },
      ],
    });
    assert.equal(replacedSkills[0]?.command, '/replacement');
    assert.match(await fs.readFile(createdSkill.sourcePath, 'utf8'), /Replacement body\./);
    await assert.rejects(
      fs.stat(path.join(path.dirname(createdSkill.sourcePath), 'scripts', 'run.js')),
      { code: 'ENOENT' },
    );

    // --- a batch with a duplicate target is rejected without writing anything ---
    const pendingBatchSkillPath = path.join(tempRoot, '.claude', 'skills', 'pending-batch', 'SKILL.md');
    await assert.rejects(
      providerSkillsService.addProviderSkills('claude', {
        entries: [
          {
            directoryName: 'pending-batch',
            content: '---\nname: pending-batch\n---\n\nPending body.\n',
          },
          {
            directoryName: 'pending-batch',
            content: '---\nname: duplicate-batch\n---\n\nDuplicate body.\n',
          },
        ],
      }),
      /duplicate skill target/i,
    );
    await assert.rejects(fs.stat(pendingBatchSkillPath), { code: 'ENOENT' });

    // --- created skills show up in listings ---
    const listedSkills = await providerSkillsService.listProviderSkills('claude');
    assert.equal(listedSkills.some((skill) => skill.name === 'replacement'), true);
    assert.equal(listedSkills.some((skill) => skill.name === 'fallback-skill'), true);

    // --- removal is idempotent ---
    const removedSkill = await providerSkillsService.removeProviderSkill('claude', {
      directoryName: 'uploaded-claude-folder',
    });
    assert.equal(removedSkill.removed, true);
    assert.equal(removedSkill.provider, 'claude');
    assert.equal(removedSkill.directoryName, 'uploaded-claude-folder');
    await assert.rejects(fs.stat(path.dirname(createdSkill.sourcePath)), { code: 'ENOENT' });

    const removedMissingSkill = await providerSkillsService.removeProviderSkill('claude', {
      directoryName: 'uploaded-claude-folder',
    });
    assert.equal(removedMissingSkill.removed, false);

    // --- supporting files may not escape the skill directory ---
    await assert.rejects(
      providerSkillsService.addProviderSkills('claude', {
        entries: [
          {
            content: '---\nname: unsafe-skill\n---\n',
            files: [
              {
                relativePath: '../outside.js',
                content: '',
                encoding: 'utf8',
              },
            ],
          },
        ],
      }),
      /invalid supporting file path/i,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Prism ships with the Claude provider only. Anything else must be rejected by
 * the registry rather than silently falling through to Claude's directories —
 * this guards the provider surface after Codex/Cursor/OpenCode were removed.
 */
test('providerSkillsService rejects providers other than claude', async () => {
  for (const provider of ['codex', 'cursor', 'opencode']) {
    await assert.rejects(
      providerSkillsService.listProviderSkills(provider as never),
      /unsupported provider/i,
    );
    await assert.rejects(
      providerSkillsService.addProviderSkills(provider as never, {
        entries: [
          {
            directoryName: 'should-not-exist',
            content: '---\nname: nope\ndescription: Unsupported\n---\n\nBody.\n',
          },
        ],
      }),
      /unsupported provider/i,
    );
    await assert.rejects(
      providerSkillsService.removeProviderSkill(provider as never, {
        directoryName: 'should-not-exist',
      }),
      /unsupported provider/i,
    );
  }
});
