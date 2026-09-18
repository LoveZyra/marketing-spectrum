/**
 * 下载:谁走"交给浏览器",谁必须留在内存里。
 *
 * ## 背景
 *
 * 原来全仓的下载都是 `fetch` → `response.blob()` → `a[download]`:整份文件**先落进
 * 标签页的内存**,拼完才弹保存框。代价是没有进度条、切页就断、大文件把标签页撑崩;
 * 文件夹更糟 —— 在浏览器里逐个文件读进内存再打 ZIP,峰值约 2× 目录大小。
 *
 * 现在有服务端现成文件的那几个入口改成:签一张短命票 → 把 URL 交给浏览器导航。
 * 进度条、暂停、落盘全归浏览器的下载管理器。
 *
 * ## 这里钉两件事
 *
 * 1. **该走导航的必须走导航**,不能有人悄悄改回 blob(改回去不会报错,只会让
 *    大文件重新"点了没反应");
 * 2. **不该走导航的必须留着 blob**,而且它们的 `revokeObjectURL` 必须推迟。
 *
 * 第 2 条里那两个例外各有硬理由:
 * - **编辑器「下载文件」**下的是**编辑器缓冲区**(可能含未保存改动),服务器上那份是
 *   旧的 —— 改成给链接会静默下到旧版本;
 * - **会话导出**的内容由服务端整份渲染后直接发,没有一个"现成文件"可指。
 *
 * 不跑 React,直接对源码断言:这些是"写法"层面的约束,渲染测试未必看得出来
 * (jsdom 里小文件走哪条路都"正常")。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(src, rel), 'utf8');

const OPS = read('components/file-tree/hooks/useFileTreeOperations.ts');
const TREE = read('components/file-tree/view/FileTree.tsx');
const WORK_PANEL = read('components/chat/view/subcomponents/ChatWorkPanel.tsx');
const TURN_OUTPUTS = read('components/chat/view/subcomponents/TurnOutputsCard.tsx');
const NAV = read('utils/browserDownload.ts');

/** 改成"交给浏览器"的五个入口,都落在这三个文件里。 */
const NAVIGATING = [
  'components/file-tree/hooks/useFileTreeOperations.ts',
  'components/chat/view/subcomponents/ChatWorkPanel.tsx',
  'components/chat/view/subcomponents/TurnOutputsCard.tsx',
];

/** 仍然必须走 blob 的两个,理由见文件头。 */
const STILL_BLOB = [
  'components/code-editor/hooks/useCodeEditorDocument.ts',
  'utils/session-export.ts',
];

describe('走导航的那几个', () => {
  it('先签票再交给浏览器,源码里不再出现 blob 那一套', () => {
    for (const rel of NAVIGATING) {
      const source = read(rel);
      expect(source).toMatch(/startBrowserDownload\(/);
      // 这三处一旦重新出现 createObjectURL,就是有人把下载改回了内存路径。
      expect(source).not.toMatch(/URL\.createObjectURL/);
      expect(source).not.toMatch(/\.download = /);
    }
  });

  it('文件树三个入口(单文件 / 目录 / 批量)共用同一条签票路径', () => {
    expect(OPS).toMatch(/api\.issueDownloadTicket\(/);
    // 单文件与目录都经 handleDownload → downloadPaths
    expect(OPS).toMatch(/const handleDownload = useCallback/);
    expect(OPS).toMatch(/await downloadPaths\(\[item\.path\], item\.name\)/);
    // 批量走导出的 downloadPaths
    expect(OPS).toMatch(/downloadPaths,/);
    expect(TREE).toMatch(/operations\.downloadPaths\(targets\.map\(/);
  });

  it('批量下载是一次请求一个包,不再是 for 循环逐个下', () => {
    /*
     * 只看 downloadSelected 这一段 —— 同文件里的 deleteSelected 也有一模一样的
     * `for (const item of targets)`,拿整份源码去断言就会把删除那段一起判进来
     * (第一版正是这么误报的)。
     */
    const start = TREE.indexOf('const downloadSelected = useCallback');
    expect(start).toBeGreaterThan(-1);
    // 到它自己的依赖数组那一行为止。切错位置(比如找一个根本不存在的终止串)
    // 会让 slice 退化成"整份文件",守卫就又变宽了 —— 第一版就是这么漏的。
    const stop = TREE.indexOf('\n  }, [', start);
    expect(stop).toBeGreaterThan(start);
    const body = TREE.slice(start, stop);
    expect(body).not.toMatch(/for \(const /);
    expect(body).toMatch(/operations\.downloadPaths\(/);
    // 失败汇总那条文案本来就是死代码(handleDownload 自己吞错,从不外抛),已删。
    expect(TREE).not.toMatch(/batchDownloadPartial/);
  });

  it('对话两处都改了 —— 工作面板和产出卡片', () => {
    expect(WORK_PANEL).toMatch(/api\.issueSessionOutputDownloadTicket\(|api\.issueDownloadTicket\(/);
    expect(TURN_OUTPUTS).toMatch(/api\.issueSessionOutputDownloadTicket\(/);
  });

  it('文件名交给服务端的 Content-Disposition,前端不再自己起名', () => {
    // 服务端那份带 RFC 5987 的中文名;前端再写一个只会和它对不上。
    for (const rel of NAVIGATING) {
      expect(read(rel)).not.toMatch(/anchor\.download/);
    }
  });

  it('打包不再在浏览器里做 —— 前端已经不引 JSZip', () => {
    for (const rel of ['components/file-tree/hooks/useFileTreeOperations.ts']) {
      expect(read(rel)).not.toMatch(/JSZip/);
    }
  });
});

describe('导航用的是隐藏 iframe,不是 a.click()', () => {
  it('用 iframe —— 失败时页面不能跳走', () => {
    /*
     * 点一个 <a href> 是先**导航**过去,看到 Content-Disposition: attachment 才转成
     * 下载。响应不是附件的时候(票据存在服务端内存里,一次发版就全没了 → 401 JSON),
     * 页面就真的跳走了,用户的整个 SPA 状态跟着没。iframe 不会。
     */
    expect(NAV).toMatch(/document\.createElement\('iframe'\)/);
    // 注意断言的是**代码**不是注释 —— 上面那段注释里就写着 `a.click()`,
    // 拿 /\.click\(\)/ 去匹配会被自己的注释匹中,变成一条永远绿的假守卫。
    expect(NAV).not.toMatch(/document\.createElement\('a'\)/);
  });

  it('iframe 不立刻移除 —— 头还没回来时移除会把导航一起取消', () => {
    expect(NAV).toMatch(/setTimeout\(\(\) => frame\.remove\(\), 60_000\)/);
  });
});

describe('仍然走 blob 的那两个', () => {
  it('还在用 blob —— 它们各有不能改的理由', () => {
    for (const rel of STILL_BLOB) {
      expect(read(rel)).toMatch(/URL\.createObjectURL/);
    }
  });

  it('释放必须推到下一拍,不能紧跟 click() 同步撤销', () => {
    for (const rel of STILL_BLOB) {
      const source = read(rel);
      expect(source).toMatch(/setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 10_000\)/);
      // 老写法:click() 之后两行内出现裸的 revokeObjectURL(url)。
      expect(source).not.toMatch(
        /anchor\.click\(\);(?:[^\n]*\n){0,2}\s*URL\.revokeObjectURL\(url\);/,
      );
    }
  });

  it('编辑器那个下的是缓冲区内容,不是磁盘上那份 —— 这是它不能改导航的理由', () => {
    const editor = read('components/code-editor/hooks/useCodeEditorDocument.ts');
    expect(editor).toMatch(/new Blob\(\[content\]/);
  });
});

describe('文案', () => {
  it('两个 locale 都有新键 —— 少一边就是换语言时画出键名', () => {
    for (const lang of ['zh-CN', 'en']) {
      const common = JSON.parse(read(path.join('i18n', 'locales', lang, 'common.json')));
      const tree = common.fileTree;
      expect(typeof tree.toast.downloadPreparing).toBe('string');
      expect(tree.toast.downloadPreparing).toContain('{{name}}');
      expect(typeof tree.batchDownloadLabel).toBe('string');
      // count 会让 i18next 去找复数键(_one/_other),这条文案不需要复数变体。
      expect(tree.batchDownloadLabel).toContain('{{selected}}');
    }
  });
});
