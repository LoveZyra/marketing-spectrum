import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * ej:时间轴与产出列表的三处外观约定,读源码钉住。
 *
 * 都是"看得见、但没有任何单元能替它把关"的细节 —— 改回去不会有测试变红,
 * 只会在用户下一次截图里出现。所以这里退一步,直接对源码断言。
 */
const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

describe('ActivityTimeline 的竖线与复制按钮', () => {
  const source = read('./ActivityTimeline.tsx');

  it('连接线随行高伸缩(flex-1),不是写死的一小截', () => {
    // 写死 h-2.5 时,展开某一行线就断在展开区顶上,下一个图标孤零零挂着。
    expect(source).toMatch(/prism-activity-link min-h-\[10px\] w-px flex-1/);
    expect(source).not.toMatch(/prism-activity-link h-2\.5 w-px flex-none/);
  });

  it('行不再 items-start —— 图标列要跟着行高撑满,线才有地方伸', () => {
    expect(source).not.toMatch(/<div key=\{row\.key\} className="flex items-start gap-2">/);
    expect(source).toMatch(/<div key=\{row\.key\} className="flex gap-2">/);
  });

  it('narration 圆点与正文首行中心对齐(格高跟着首行算,不是拍脑袋的 26px)', () => {
    // 正文 py-1.5(6px)+ 13.5/22 首行 → 中心 17px;格高 34 时圆点正落在那儿。
    // 26px 时圆点比字高 4px —— 探针量出来就是 −4。
    expect(source).toMatch(/flex h-\[34px\] items-center justify-center/);
    expect(source).not.toMatch(/flex h-\[26px\] items-center justify-center/);
  });

  it('一段正文只有一枚复制按钮(ClampedBlock 右上角那枚)', () => {
    expect(source).not.toMatch(/^import MessageCopyControl/m);
    expect(source).not.toMatch(/<MessageCopyControl/);
    expect(source).toMatch(/<ClampedBlock maxHeight=\{320\} copyText=\{narrationText\}>/);
  });
});

describe('产出列表的文件图标', () => {
  it('两处产出都走 FileTypeIcon(与文件管理器同一套映射)', () => {
    for (const name of ['./ChatWorkPanel.tsx', './TurnOutputsCard.tsx']) {
      const source = read(name);
      expect(source, name).toMatch(/<FileTypeIcon path=\{file\.path\} \/>/);
      // 一律 FileText 的老写法不能回来:一列产出里 .py/.svg/.html 得分得开。
      expect(source, name).not.toMatch(/FileText className="filetype-doc/);
    }
  });

  it('FileTypeIcon 直接复用 file-tree 的映射,不另起炉灶', () => {
    const source = read('./FileTypeIcon.tsx');
    expect(source).toMatch(/from '\.\.\/\.\.\/\.\.\/file-tree\/constants\/fileIcons'/);
    expect(source).toMatch(/getFileIconData/);
    expect(source).toMatch(/getFileFamily/);
  });
});
