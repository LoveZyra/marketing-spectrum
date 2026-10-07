import { describe, expect, it } from 'vitest';

import { extractSessionChecklist, extractSessionChecklistWithTurn } from './taskChecklist';
import { extractSessionOutputs } from './sessionOutputs';
import {
  changedFilesToMessages,
  turnMarkerMessage,
  workFramesRequestHeaders,
  workFramesToMessages,
  type SessionWorkFrame,
} from './workFrames';

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

  /**
   * 服务端只下发折叠会读的字段(Write 不带正文,Task* 只留 subject / taskId / status,结果只留预览)。
   * 同一组调用,完整帧与收窄帧折出来必须一样;哪天折叠开始读被删掉的字段,这里会红。
   */
  it('收窄过的帧与完整帧折出同一份清单和产出', () => {
    const body = 'line\n'.repeat(20000);
    const full: SessionWorkFrame[] = [
      { toolName: 'TaskCreate', toolInput: { subject: '甲', description: '甲的详细说明', activeForm: '正在做甲' }, resultContent: 'Task #1 created successfully: 甲', resultIsError: false, turn: 1 },
      { toolName: 'TaskCreate', toolInput: { subject: '乙', description: '乙的详细说明', activeForm: '正在做乙' }, resultContent: 'Task #2 created successfully: 乙', resultIsError: false, turn: 1 },
      { toolName: 'TaskUpdate', toolInput: { taskId: '1', status: 'completed', activeForm: '做完甲', owner: 'agent', description: '改' }, resultContent: 'Updated task #1 status', resultIsError: false, turn: 1 },
      { toolName: 'TaskUpdate', toolInput: { taskId: '2', status: 'in_progress', subject: '乙(改名)' }, resultContent: 'Updated task #2 status', resultIsError: false, turn: 2 },
      { toolName: 'Write', toolInput: { file_path: '/p/a.md', content: body }, resultContent: `The file /p/a.md has been updated.\n${body}`, resultIsError: false, turn: 2 },
      { toolName: 'Write', toolInput: { file_path: '/p/拒.md', content: body }, resultContent: 'EACCES', resultIsError: true, turn: 2 },
      { toolName: 'Write', toolInput: { file_path: '/p/在途.md', content: body }, resultContent: null, resultIsError: false, turn: 2 },
    ];
    const slim: SessionWorkFrame[] = [
      { toolName: 'TaskCreate', toolInput: { subject: '甲' }, resultContent: 'Task #1 created successfully: 甲', resultIsError: false, turn: 1, inputTrimmed: true },
      { toolName: 'TaskCreate', toolInput: { subject: '乙' }, resultContent: 'Task #2 created successfully: 乙', resultIsError: false, turn: 1, inputTrimmed: true },
      { toolName: 'TaskUpdate', toolInput: { taskId: '1', status: 'completed' }, resultContent: 'Updated task #1 status', resultIsError: false, turn: 1, inputTrimmed: true },
      { toolName: 'TaskUpdate', toolInput: { taskId: '2', status: 'in_progress', subject: '乙(改名)' }, resultContent: 'Updated task #2 status', resultIsError: false, turn: 2 },
      { toolName: 'Write', toolInput: { file_path: '/p/a.md' }, resultContent: 'The file /p/a.md has been updated.\nline\nline', resultIsError: false, turn: 2, inputTrimmed: true, resultTrimmed: true },
      { toolName: 'Write', toolInput: { file_path: '/p/拒.md' }, resultContent: 'EACCES', resultIsError: true, turn: 2, inputTrimmed: true },
      { toolName: 'Write', toolInput: { file_path: '/p/在途.md' }, resultContent: null, resultIsError: false, turn: 2, inputTrimmed: true },
    ];
    const fullMessages = [...workFramesToMessages(full), ...turnMarkerMessage(2)];
    const slimMessages = [...workFramesToMessages(slim), ...turnMarkerMessage(2)];
    expect(extractSessionChecklistWithTurn(slimMessages)).toEqual(extractSessionChecklistWithTurn(fullMessages));
    expect(extractSessionChecklistWithTurn(slimMessages).items?.map((item) => item.content)).toEqual(['甲', '乙(改名)']);
    expect(extractSessionOutputs(slimMessages)).toEqual(extractSessionOutputs(fullMessages));
    expect(extractSessionOutputs(slimMessages).map((file) => file.path)).toEqual(['/p/a.md']);
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

describe('workFramesRequestHeaders(重取时的条件请求头)', () => {
  it('手里有同一会话的 ETag 才带 If-None-Match', () => {
    expect(workFramesRequestHeaders(null, 's1')).toBeUndefined();
    expect(workFramesRequestHeaders({ sessionId: 's2', etag: '"x"' }, 's1')).toBeUndefined();
    expect(workFramesRequestHeaders({ sessionId: 's1', etag: '' }, 's1')).toBeUndefined();
    expect(workFramesRequestHeaders({ sessionId: 's1', etag: '"x"' }, 's1')).toEqual({ 'If-None-Match': '"x"' });
  });
});
