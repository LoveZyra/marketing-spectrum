import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test } from 'vitest';

/**
 * hl(09-24 静态 P3 / 复核 P3-9):输入框只认 Shift+Tab 切执行模式(普通 Tab 交还焦点移动),
 * 所有语种里提到这个快捷键的文案都得跟着改 —— 复核时 clickToChangeMode 就漏了一整排。
 */
const LOCALES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'locales');

describe('执行模式快捷键文案', () => {
  test('每个语种的 hintText / clickToChangeMode 只写 Shift+Tab,不再有裸 Tab', () => {
    for (const lang of fs.readdirSync(LOCALES)) {
      const file = path.join(LOCALES, lang, 'chat.json');
      if (!fs.existsSync(file)) continue;
      const input = (JSON.parse(fs.readFileSync(file, 'utf8')) as { input?: Record<string, unknown> }).input ?? {};
      const hints = input.hintText as Record<string, string> | undefined;
      const texts = [input.clickToChangeMode, hints?.enter, hints?.ctrlEnter].filter((v): v is string => typeof v === 'string');
      for (const text of texts) {
        assert.ok(text.includes('Shift+Tab'), `${lang}: ${text}`);
        assert.ok(!/(^|[^+])Tab/.test(text.replace(/Shift\+Tab/g, '')), `${lang} 还有裸 Tab: ${text}`);
      }
    }
  });
});
