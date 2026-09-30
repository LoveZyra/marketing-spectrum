import assert from 'node:assert/strict';

import { describe, test } from 'vitest';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

import {
  LIGHT_CODE_BACKGROUNDS,
  contrastRatio,
  darkenToContrast,
  parseHsl,
  withAccessibleContrast,
} from './accessibleCodeTheme';

const toRgb = (hsl: string) => {
  const [h, s, l] = parseHsl(hsl)!;
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)] as [number, number, number];
};

describe('hl(P3 可访问性)浅色代码高亮对比度', () => {
  test('基线 oneLight 的注释色在浅底上不到 4.5:1(反向:证明这条修复有东西可修)', () => {
    const comment = (oneLight as Record<string, { color?: string }>).comment.color!;
    assert.ok(LIGHT_CODE_BACKGROUNDS.some((bg) => contrastRatio(toRgb(comment), bg) < 4.5));
  });

  test('处理后每个 hsl() 前景色对三种底色都 ≥ 4.5:1', () => {
    const fixed = withAccessibleContrast(oneLight as Record<string, Record<string, unknown>>);
    let checked = 0;
    for (const rules of Object.values(fixed)) {
      if (typeof rules.color !== 'string' || !parseHsl(rules.color)) continue;
      for (const bg of LIGHT_CODE_BACKGROUNDS) {
        assert.ok(contrastRatio(toRgb(rules.color), bg) >= 4.5, `${rules.color} 对比度不足`);
      }
      checked += 1;
    }
    assert.ok(checked > 50);
  });

  test('已达标的颜色原样返回,色相与饱和度不变', () => {
    assert.equal(darkenToContrast('hsl(230, 8%, 24%)', LIGHT_CODE_BACKGROUNDS[0]), 'hsl(230, 8%, 24%)');
    assert.match(darkenToContrast('hsl(230, 4%, 64%)', LIGHT_CODE_BACKGROUNDS[2]), /^hsl\(230, 4%, \d+%\)$/);
    assert.equal(darkenToContrast('inherit', LIGHT_CODE_BACKGROUNDS[0]), 'inherit');
  });
});
