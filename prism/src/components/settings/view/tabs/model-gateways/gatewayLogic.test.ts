import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  FORM_PROBLEMS,
  FORM_PROBLEM_FALLBACKS,
  KEY_MAX_LENGTH,
  baseUrlSavedAs,
  checkBaseUrl,
  describeAudience,
  describeDefaultKey,
  describeKeySource,
  filterUsers,
  formProblemKey,
  formProblemVars,
  gatewayFormProblem,
  keyProblem,
  maskKey,
  namesOf,
  parseDbTime,
  privateSectionMode,
  splitMyGateways,
  toggleUserId,
  unsavedTestProblem,
  withCurrentChoice,
  withPrivateModelCounts,
  type GatewayChoice,
} from './gatewayLogic';

const LANGS = ['de', 'en', 'fr', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW'];

const readLocale = (lang: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../../i18n/locales/${lang}/settings.json`, import.meta.url)), 'utf8')) as Record<string, unknown>;

const lookup = (dict: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), dict);

describe('keyProblem(与服务端 normalizeKey 同口径)', () => {
  test('空 / 只有空白 → needKey', () => {
    expect(keyProblem('')).toBe('needKey');
    expect(keyProblem('   ')).toBe('needKey');
  });

  test('首尾空白会被裁掉,不算问题', () => {
    expect(keyProblem('  sk-abc123  ')).toBeNull();
    expect(keyProblem('sk-abc123\n')).toBeNull();
  });

  test('中间有空格 / 换行 / 制表符 → keyWhitespace(粘贴带进来的)', () => {
    expect(keyProblem('sk-abc 123')).toBe('keyWhitespace');
    expect(keyProblem('sk-abc\n123')).toBe('keyWhitespace');
    expect(keyProblem('sk-abc\t123')).toBe('keyWhitespace');
    expect(keyProblem('sk-abc\u0000123')).toBe('keyWhitespace');
  });

  test('超长 → keyTooLong', () => {
    expect(keyProblem('k'.repeat(KEY_MAX_LENGTH))).toBeNull();
    expect(keyProblem('k'.repeat(KEY_MAX_LENGTH + 1))).toBe('keyTooLong');
  });
});

describe('checkBaseUrl(与服务端 normalizeBaseUrl 同口径)', () => {
  test('合法地址:去掉末尾的 / 与 /v1', () => {
    expect(checkBaseUrl('https://gateway.example.com')).toEqual({ ok: true, normalized: 'https://gateway.example.com' });
    expect(checkBaseUrl('https://gateway.example.com/')).toEqual({ ok: true, normalized: 'https://gateway.example.com' });
    expect(checkBaseUrl(' https://gateway.example.com/v1/ ')).toEqual({ ok: true, normalized: 'https://gateway.example.com' });
    expect(checkBaseUrl('http://10.0.0.2:8080/tenant/abc/V1')).toEqual({ ok: true, normalized: 'http://10.0.0.2:8080/tenant/abc' });
  });

  test('各种不合法', () => {
    expect(checkBaseUrl('')).toEqual({ ok: false, problem: 'needBaseUrl' });
    expect(checkBaseUrl('gateway.example.com')).toEqual({ ok: false, problem: 'baseUrlInvalid' });
    expect(checkBaseUrl('ftp://gateway.example.com')).toEqual({ ok: false, problem: 'baseUrlProtocol' });
    expect(checkBaseUrl('https://user:pass@gateway.example.com')).toEqual({ ok: false, problem: 'baseUrlCredentials' });
    expect(checkBaseUrl('https://gateway.example.com/#x')).toEqual({ ok: false, problem: 'baseUrlHash' });
    expect(checkBaseUrl(`https://g.example.com/${'a'.repeat(500)}`)).toEqual({ ok: false, problem: 'baseUrlTooLong' });
  });

  test('baseUrlSavedAs:存的与填的不同才提示', () => {
    expect(baseUrlSavedAs('https://gateway.example.com')).toBeNull();
    expect(baseUrlSavedAs('https://gateway.example.com/v1')).toBe('https://gateway.example.com');
    expect(baseUrlSavedAs('not a url')).toBeNull();
  });
});

describe('gatewayFormProblem / unsavedTestProblem', () => {
  const ok = { name: 'GLM 网关', baseUrl: 'https://gateway.example.com', key: '' };

  test('按字段顺序报第一个问题', () => {
    expect(gatewayFormProblem({ ...ok, name: ' ' }, 'optional')).toBe('needName');
    expect(gatewayFormProblem({ ...ok, name: 'n'.repeat(61) }, 'optional')).toBe('nameTooLong');
    expect(gatewayFormProblem({ ...ok, baseUrl: '' }, 'optional')).toBe('needBaseUrl');
    expect(gatewayFormProblem(ok, 'optional')).toBeNull();
  });

  test('key 可选:留空可以,填了要合法;编辑表单不看 key', () => {
    expect(gatewayFormProblem({ ...ok, key: 'sk a' }, 'optional')).toBe('keyWhitespace');
    expect(gatewayFormProblem({ ...ok, key: 'sk-ok' }, 'optional')).toBeNull();
    expect(gatewayFormProblem({ ...ok, key: 'sk a' }, 'none')).toBeNull();
  });

  test('先测试:没保存的网关必须带 key', () => {
    expect(unsavedTestProblem({ baseUrl: ok.baseUrl, key: '' })).toBe('needKey');
    expect(unsavedTestProblem({ baseUrl: 'x', key: 'sk' })).toBe('baseUrlInvalid');
    expect(unsavedTestProblem({ baseUrl: ok.baseUrl, key: 'sk-1' })).toBeNull();
  });
});

describe('key 的显示', () => {
  test('maskKey 只露末四位', () => {
    expect(maskKey('abcd')).toBe('····abcd');
    expect(maskKey(null)).toBe('····');
  });

  test('describeKeySource:个人 key 由别人代填时带上填的人', () => {
    expect(describeKeySource({ source: 'personal', personalLast4: 'abcd', personalSetBy: 'alice' }, 'alice'))
      .toEqual({ kind: 'personal', last4: 'abcd', setByOther: null });
    expect(describeKeySource({ source: 'personal', personalLast4: 'abcd', personalSetBy: 'root' }, 'alice'))
      .toEqual({ kind: 'personal', last4: 'abcd', setByOther: 'root' });
    expect(describeKeySource({ source: 'personal', personalLast4: 'abcd', personalSetBy: null }, 'alice'))
      .toEqual({ kind: 'personal', last4: 'abcd', setByOther: null });
  });

  test('describeKeySource:其余三种来源', () => {
    const none = { personalLast4: null, personalSetBy: null };
    expect(describeKeySource({ source: 'gateway_default', ...none }, 'a')).toEqual({ kind: 'gatewayDefault' });
    expect(describeKeySource({ source: 'settings', ...none }, 'a')).toEqual({ kind: 'settings' });
    expect(describeKeySource({ source: 'none', ...none }, 'a')).toEqual({ kind: 'none' });
  });

  test('describeDefaultKey', () => {
    expect(describeDefaultKey({ hasDefaultKey: true, defaultKeyLast4: 'wxyz' })).toEqual({ kind: 'set', last4: 'wxyz' });
    expect(describeDefaultKey({ hasDefaultKey: false, defaultKeyLast4: null })).toEqual({ kind: 'missing' });
  });
});

describe('我的网关页', () => {
  test('splitMyGateways:私有网关单独一块', () => {
    const list = [{ scope: 'default' as const, id: 0 }, { scope: 'shared' as const, id: 2 }, { scope: 'private' as const, id: 5 }];
    const { keyed, owned } = splitMyGateways(list);
    expect(keyed.map((item) => item.id)).toEqual([0, 2]);
    expect(owned.map((item) => item.id)).toEqual([5]);
  });

  test('withPrivateModelCounts:网关行上的模型数按手上的私有模型现算', () => {
    const owned = [{ id: 5, modelCount: 9 }, { id: 6, modelCount: 1 }];
    const counted = withPrivateModelCounts(owned, [{ gatewayId: 5 }, { gatewayId: 5 }, { gatewayId: 7 }]);
    expect(counted.map((gateway) => gateway.modelCount)).toEqual([2, 0]);
  });

  test('privateSectionMode:关掉后还有旧的 → 只读(只能删);都没有 → 不画', () => {
    expect(privateSectionMode(true, 0)).toBe('active');
    expect(privateSectionMode(false, 2)).toBe('readonly');
    expect(privateSectionMode(false, 0, 1)).toBe('readonly');
    expect(privateSectionMode(false, 0)).toBe('hidden');
  });
});

describe('目录编辑器:网关 / 可用人员', () => {
  const shared: GatewayChoice[] = [{ id: 3, name: 'GLM', host: 'glm.example.com', enabled: true, hasDefaultKey: true }];

  test('withCurrentChoice:当前网关不在列表里时补一项占位(保存时不会被悄悄改掉)', () => {
    expect(withCurrentChoice(shared, 3)).toHaveLength(1);
    expect(withCurrentChoice(shared, 0)).toHaveLength(1);
    const patched = withCurrentChoice(shared, 9);
    expect(patched).toHaveLength(2);
    expect(patched[1]).toMatchObject({ id: 9, name: '#9', missing: true });
  });

  test('describeAudience:null = 所有人,数组 = 限 N 人(空数组 = 只有 root)', () => {
    expect(describeAudience(null)).toEqual({ kind: 'everyone' });
    expect(describeAudience(undefined)).toEqual({ kind: 'everyone' });
    expect(describeAudience([1, 2])).toEqual({ kind: 'some', count: 2 });
    expect(describeAudience([])).toEqual({ kind: 'some', count: 0 });
  });

  test('namesOf:找不到的写 #id', () => {
    expect(namesOf([1, 7], [{ id: 1, username: 'alice' }])).toEqual(['alice', '#7']);
    expect(namesOf([2], null)).toEqual(['#2']);
  });

  test('toggleUserId:按 id 升序、不重复', () => {
    expect(toggleUserId([5, 1], 3)).toEqual([1, 3, 5]);
    expect(toggleUserId([1, 3, 5], 3)).toEqual([1, 5]);
  });

  test('filterUsers:用户名包含,不分大小写', () => {
    const users = [{ id: 1, username: 'Alice' }, { id: 2, username: 'bob' }];
    expect(filterUsers(users, 'al').map((user) => user.id)).toEqual([1]);
    expect(filterUsers(users, '  ')).toHaveLength(2);
  });
});

describe('parseDbTime(SQLite 的 UTC 时间没有 T / Z)', () => {
  test('当成 UTC 解析', () => {
    expect(parseDbTime('2026-10-01 05:00:00')?.toISOString()).toBe('2026-10-01T05:00:00.000Z');
    expect(parseDbTime('2026-10-01T05:00:00.000Z')?.toISOString()).toBe('2026-10-01T05:00:00.000Z');
  });

  test('认不出 / 空 → null', () => {
    expect(parseDbTime('yesterday')).toBeNull();
    expect(parseDbTime(null)).toBeNull();
  });
});

describe('表单问题的文案在 10 份 locale 里都有,插值一致', () => {
  test.each(LANGS)('%s', (lang) => {
    const dict = readLocale(lang);
    for (const problem of FORM_PROBLEMS) {
      const value = lookup(dict, formProblemKey(problem));
      expect(typeof value, `${lang} 缺 ${formProblemKey(problem)}`).toBe('string');
      const wantsMax = Object.keys(formProblemVars(problem)).length > 0;
      expect((value as string).includes('{{max}}'), `${lang} ${problem} 的 {{max}}`).toBe(wantsMax);
    }
  });

  test('中文兜底与 zh-CN 一致', () => {
    const zh = readLocale('zh-CN');
    for (const problem of FORM_PROBLEMS) {
      expect(lookup(zh, formProblemKey(problem))).toBe(FORM_PROBLEM_FALLBACKS[problem]);
    }
  });
});
