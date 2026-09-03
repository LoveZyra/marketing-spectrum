import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * ec:密码框必须待在自己的 <form> 里,并且带一个 autocomplete=username 的字段。
 *
 * 用户实测:点开设置 →「我的账号」,侧栏的**项目搜索框**里凭空出现登录名,项目
 * 列表随即被过滤成「未找到匹配的项目」。不是快捷键,是浏览器密码管理器:页面上
 * 一出现 `current-password` 字段,Chrome 就把保存的密码填进去,并顺手找一个
 * "用户名框"填用户名 —— 密码框不在任何 form 里时,Chrome 把整页当一张表单,取
 * 密码框之前最近的文本输入框,那正好是侧栏搜索框。
 *
 * 客户端测试跑在 node 环境(没有 jsdom),渲染不了;而"密码框在不在 form 里"
 * 又恰恰是密码管理器行为的分水岭。这里读源码把三件事钉死:
 *   1. 密码框前面有 <form 开头、后面有 </form> 收尾(不是裸 <div>);
 *   2. 同一个 form 里有 autocomplete="username" 的字段;
 *   3. 侧栏搜索框显式 autoComplete="off"。
 */

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 每个 type="password" 的 <input>,向前找最近的 <form / </form>:必须是 <form。 */
function passwordInputsAreInsideForms(source: string): { total: number; insideForm: number } {
  const re = /<input\b[^>]*type="password"[^>]*>/g;
  let total = 0;
  let insideForm = 0;
  for (let match = re.exec(source); match; match = re.exec(source)) {
    total += 1;
    const before = source.slice(0, match.index);
    const open = before.lastIndexOf('<form');
    const close = before.lastIndexOf('</form>');
    if (open > -1 && open > close) insideForm += 1;
  }
  return { total, insideForm };
}

function formsContainUsernameField(source: string): boolean {
  const forms = source.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
  expect(forms.length, '没有找到任何 <form>').toBeGreaterThan(0);
  return forms.every((form) => /autoComplete="username"/.test(form) && /type="password"/.test(form));
}

describe('密码表单不再把用户名漏给侧栏搜索框', () => {
  it('我的账号:三个密码框都在 form 里,form 里带 username 字段', () => {
    const source = read('./AccountSettingsTab.tsx');
    const counted = passwordInputsAreInsideForms(source);
    expect(counted.total).toBe(3);
    expect(counted.insideForm).toBe(3);
    expect(formsContainUsernameField(source)).toBe(true);
    // 当前密码 / 新密码 的语义标记不能丢:Chrome 靠它们区分"填旧的"和"提议新的"。
    expect(source).toMatch(/autoComplete="current-password"/);
    expect((source.match(/autoComplete="new-password"/g) ?? []).length).toBe(2);
  });

  it('账号审批:重置密码的输入框同样在 form 里,带被重置账号的 username 字段', () => {
    const source = read('./accounts-settings/AccountsSettingsTab.tsx');
    const counted = passwordInputsAreInsideForms(source);
    expect(counted.total).toBe(1);
    expect(counted.insideForm).toBe(1);
    expect(formsContainUsernameField(source)).toBe(true);
    expect(source).toMatch(/autoComplete="new-password"/);
  });

  it('侧栏搜索框显式关闭自动填充,并挂密码管理器的忽略标记', () => {
    const source = read('../../../sidebar/view/subcomponents/SidebarHeader.tsx');
    const at = source.indexOf('value={searchFilter}');
    expect(at).toBeGreaterThan(-1);
    const tag = source.slice(source.lastIndexOf('<Input', at), at);
    expect(tag).toMatch(/autoComplete="off"/);
    expect(tag).toMatch(/data-lpignore="true"/);
    expect(tag).toMatch(/data-1p-ignore="true"/);
  });
});
