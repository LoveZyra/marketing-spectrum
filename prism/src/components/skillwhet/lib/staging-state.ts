import type { Tone } from '../view/StatusStrip';

import type { StagingSummary } from './types';

/** 一份 staging 的状态 → 徽章色(版本页与评测页共用)。 */
export function stagingTone(s: StagingSummary): { tone: Tone; key: 'adopted' | 'improved' | 'unchanged' | 'stopped' } {
  if (s.adopted) return { tone: 'ok', key: 'adopted' };
  if (s.stop_reason === 'budget' || s.stop_reason === 'timeout') return { tone: 'bad', key: 'stopped' };
  return s.improved ? { tone: 'warn', key: 'improved' } : { tone: 'muted', key: 'unchanged' };
}
