import { describe, expect, it } from 'vitest';

import { FAMILY_COLOR_CLASS, getFileFamily, getFileIconData } from './fileIcons';

/**
 * ej:产出列表改用**文件管理器同一套**图标之后,这份映射多了两个调用方
 * (右侧产出表、正文下的产出卡)。用户看到的正是这里的分辨力:一列产出里
 * `.md` / `.svg` / `.html` / `.py` / `.sh` 必须一眼分得开,不能全是同一个文档图标。
 */
describe('getFileIconData', () => {
  it('用户产出里常见的几类各有各的图标(不是一律 FileText)', () => {
    const icons = ['plan.md', 'logo.svg', 'preview.html', 'urlparse.py', 'countdown.sh', 'data.csv']
      .map((name) => getFileIconData(name).icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('解析顺序:整名 > .env 前缀 > 扩展名 > 兜底', () => {
    expect(getFileIconData('package-lock.json').icon).not.toBe(getFileIconData('data.json').icon);
    expect(getFileIconData('.env.production').icon).toBe(getFileIconData('.env').icon);
    expect(getFileIconData('大写.MD').icon).toBe(getFileIconData('x.md').icon);
    expect(getFileIconData('无扩展名').icon).toBeTruthy();
  });
});

describe('getFileFamily', () => {
  it('七族各归各位,颜色类齐全', () => {
    expect(getFileFamily('app.ts')).toBe('code');
    expect(getFileFamily('rows.csv')).toBe('data');
    expect(getFileFamily('vite.yml')).toBe('config');
    expect(getFileFamily('README.md')).toBe('doc');
    expect(getFileFamily('run.sh')).toBe('runtime');
    expect(getFileFamily('.env.local')).toBe('secret');
    expect(getFileFamily('mystery')).toBe('plain');
    expect(getFileFamily('src', true)).toBe('dir');
    for (const family of ['dir', 'code', 'data', 'config', 'doc', 'runtime', 'secret', 'plain'] as const) {
      expect(FAMILY_COLOR_CLASS[family]).toBeTruthy();
    }
  });
});
