import { describe, expect, it } from 'vitest';

import { extractSessionChecklist } from './taskChecklist';
import { extractSessionOutputs } from './sessionOutputs';
import { changedFilesToMessages, workFramesToMessages, type SessionWorkFrame } from './workFrames';

const frames: SessionWorkFrame[] = [
  {
    toolName: 'TaskCreate',
    toolInput: { subject: '基线任务' },
    resultContent: 'Task #3 created successfully: 基线任务',
    resultIsError: false,
  },
  {
    toolName: 'Write',
    toolInput: { file_path: '/p/基线报告.md', content: 'x' },
    resultContent: 'ok',
    resultIsError: false,
  },
  {
    // 结果未落地的 Write:toolResult 应为 null → 不算产出
    toolName: 'Write',
    toolInput: { file_path: '/p/在途.md' },
    resultContent: null,
    resultIsError: false,
  },
];

describe('workFramesToMessages', () => {
  it('转出的伪消息可直接喂两个折叠函数,规则与实时消息一致', () => {
    const messages = workFramesToMessages(frames);
    expect(messages).toHaveLength(3);
    expect(messages[2].toolResult).toBeNull();

    expect(extractSessionChecklist(messages)).toEqual([{ content: '基线任务', status: 'pending' }]);
    expect(extractSessionOutputs(messages).map((file) => file.name)).toEqual(['基线报告.md']);
  });

  it('坏帧(缺 toolName)被滤掉', () => {
    const dirty = [...frames, { toolInput: {}, resultContent: null, resultIsError: false } as unknown as SessionWorkFrame];
    expect(workFramesToMessages(dirty)).toHaveLength(3);
  });
});

describe('changedFilesToMessages(实时 changed_files 帧 → 伪 Write)', () => {
  it('只算新增,相对路径拼 cwd,产物可直接进产出折叠', () => {
    const messages = changedFilesToMessages('/home/ubuntu/demo/', [
      { path: 'users.csv', untracked: true },
      { path: 'attachments/random_content.md', status: 'added' },
      { path: '旧文件.md', status: 'modified' },
      { path: '' },
    ]);
    expect(extractSessionOutputs(messages).map((file) => file.path)).toEqual([
      '/home/ubuntu/demo/users.csv',
      '/home/ubuntu/demo/attachments/random_content.md',
    ]);
    // 无 cwd → 保留相对路径
    expect(changedFilesToMessages(null, [{ path: 'a.md', status: 'added' }])[0].toolInput)
      .toEqual({ file_path: 'a.md' });
  });
});
