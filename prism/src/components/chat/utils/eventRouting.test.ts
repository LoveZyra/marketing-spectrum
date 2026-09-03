import { describe, expect, it, vi } from 'vitest';

import {
  RUN_SESSION_MAP_CAP,
  createDropWarner,
  learnRunSession,
  resolveEventSid,
} from './eventRouting';

describe('learnRunSession / resolveEventSid', () => {
  it('learns the mapping only when both ids are present', () => {
    const map = new Map<string, string>();
    learnRunSession(map, { runId: 'run_a', sessionId: 'sess_1' });
    learnRunSession(map, { runId: 'run_b' });
    learnRunSession(map, { sessionId: 'sess_2' });
    learnRunSession(map, { runId: '', sessionId: 'sess_3' });
    expect(map.size).toBe(1);
    expect(map.get('run_a')).toBe('sess_1');
  });

  it('resolves by explicit sessionId first, then by runId, else null', () => {
    const map = new Map<string, string>([['run_a', 'sess_1']]);
    expect(resolveEventSid(map, { sessionId: 'sess_9', runId: 'run_a' })).toBe('sess_9');
    expect(resolveEventSid(map, { runId: 'run_a' })).toBe('sess_1');
    expect(resolveEventSid(map, { runId: 'run_unknown' })).toBeNull();
    expect(resolveEventSid(map, {})).toBeNull();
    expect(resolveEventSid(map, { sessionId: 42 as unknown })).toBeNull();
  });

  it('an id-less frame from a known run is attributed to that run, never to the viewed session', () => {
    const map = new Map<string, string>();
    // 后台会话 B 的首帧带全了 id,之后的边角帧只带 runId ——
    learnRunSession(map, { runId: 'run_bg', sessionId: 'sess_background' });
    const sid = resolveEventSid(map, { runId: 'run_bg', kind: 'tool_use' });
    expect(sid).toBe('sess_background');
  });

  it('evicts the oldest mapping at the cap instead of growing unbounded', () => {
    const map = new Map<string, string>();
    for (let index = 0; index < RUN_SESSION_MAP_CAP + 5; index++) {
      learnRunSession(map, { runId: `run_${index}`, sessionId: `sess_${index}` });
    }
    expect(map.size).toBe(RUN_SESSION_MAP_CAP);
    expect(map.has('run_0')).toBe(false);
    expect(map.get(`run_${RUN_SESSION_MAP_CAP + 4}`)).toBe(`sess_${RUN_SESSION_MAP_CAP + 4}`);
  });

  it('re-learning an existing runId does not evict anything', () => {
    const map = new Map<string, string>();
    for (let index = 0; index < RUN_SESSION_MAP_CAP; index++) {
      learnRunSession(map, { runId: `run_${index}`, sessionId: `sess_${index}` });
    }
    learnRunSession(map, { runId: 'run_0', sessionId: 'sess_0_updated' });
    expect(map.size).toBe(RUN_SESSION_MAP_CAP);
    expect(map.get('run_0')).toBe('sess_0_updated');
  });
});

describe('createDropWarner', () => {
  it('warns once per (kind, runId) pair', () => {
    const warn = vi.fn();
    const warnDropped = createDropWarner(warn);
    warnDropped({ kind: 'tool_use', runId: 'run_a' });
    warnDropped({ kind: 'tool_use', runId: 'run_a' });
    warnDropped({ kind: 'text', runId: 'run_a' });
    warnDropped({ kind: 'tool_use', runId: 'run_b' });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('handles missing kind/runId and stays bounded', () => {
    const warn = vi.fn();
    const warnDropped = createDropWarner(warn, 3);
    warnDropped({});
    warnDropped({});
    expect(warn).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 10; index++) {
      warnDropped({ kind: `k${index}` });
    }
    expect(warn.mock.calls.length).toBeGreaterThan(1);
  });
});
