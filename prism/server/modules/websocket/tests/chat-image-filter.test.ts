import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import { filterImagesToUploadStore } from '@/modules/websocket/services/chat-websocket.service.js';

const STORE = path.join(os.tmpdir(), 'prism-assets-store');

test('images inside the upload store pass through', () => {
  const inside = path.join(STORE, 'shot.png');
  const result = filterImagesToUploadStore(
    [{ path: inside, name: 'shot.png', mimeType: 'image/png' }],
    STORE,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, inside);
});

test('bare filenames are anchored inside the store', () => {
  const result = filterImagesToUploadStore(['shot.png'], STORE);
  assert.equal(result.length, 1);
});

test('paths outside the store, traversal, and subdirs are dropped', () => {
  const result = filterImagesToUploadStore(
    [
      { path: 'C:/Users/victim/.ssh/id_rsa' },
      { path: '/etc/passwd' },
      { path: '../outside.png' },
      { path: path.join(STORE, '..', 'escaped.png') },
      { path: path.join(STORE, 'nested', 'deep.png') },
      { path: STORE }, // the store folder itself is not a file
    ],
    STORE,
  );
  assert.deepEqual(result, []);
});

test('malformed payloads yield no images', () => {
  assert.deepEqual(filterImagesToUploadStore(undefined, STORE), []);
  assert.deepEqual(filterImagesToUploadStore('nope', STORE), []);
  assert.deepEqual(filterImagesToUploadStore([{ name: 'no-path' }, 42], STORE), []);
});

/**
 * ed:会话项目的 attachments/ 也是合法来源。
 * cu 起图片按项目落盘,这道门却只认全局目录 —— 项目会话里的每张图都被丢:模型看不到、
 * 落库的用户行没有 images、回合一结束气泡里的图就消失(用户实测)。
 */
test('session project attachments/ is an additional allowed root (direct children only)', () => {
  const projectAttachments = path.join(os.tmpdir(), 'probe-proj', 'attachments');
  const result = filterImagesToUploadStore(
    [
      { path: path.join(projectAttachments, 'shot.png'), name: 'shot.png', mimeType: 'image/png' },
      { path: path.join(STORE, 'global.png') },
      { path: path.join(projectAttachments, 'nested', 'deep.png') },
      { path: path.join(projectAttachments, '..', 'src', 'secret.png') },
      { path: path.join(os.tmpdir(), 'other-proj', 'attachments', 'x.png') },
    ],
    STORE,
    [projectAttachments],
  );
  assert.deepEqual(result.map((entry) => entry.path), [
    path.join(projectAttachments, 'shot.png'),
    path.join(STORE, 'global.png'),
  ]);
});

test('no extra roots → behaviour unchanged (only the global store)', () => {
  const projectAttachments = path.join(os.tmpdir(), 'probe-proj', 'attachments');
  const result = filterImagesToUploadStore([{ path: path.join(projectAttachments, 'shot.png') }], STORE);
  assert.deepEqual(result, []);
});

/**
 * A7:**台账兜底** —— 图片落在哪个目录由上传那一刻决定,而这道门比的是
 * `sessions.project_path`。两者是两个不同来源的值:
 *
 *   - 落盘目录 ← 前端传的 `projectId`(侧栏选中的项目)→ `projects.project_path`
 *   - 这道门   ← `sessions.project_path`
 *
 * 对不齐时图片在这里被静默丢掉,而**页面上照样显示得好好的**(前端按侧栏
 * projectId 走 `/api/projects/:id/files/content` 取原图)—— 用户看到的是
 * "图在页面上,模型却说传不进来",除了服务端一行 warn 没有任何线索。
 * root 尤其容易踩:它对所有项目可见,上传一定落进某个项目的 attachments/。
 *
 * 落盘那一侧已经改成按会话解析(见 assets.routes),这里是**历史文件的退路**:
 * 目录改不了,但归属是服务端在落盘那一刻记下的,有据可查。
 */
const otherProjectAttachments = path.join(os.tmpdir(), 'wrong-proj', 'attachments');
const strayImage = path.join(otherProjectAttachments, 'shot.png');
const sessionProjectAttachments = path.join(os.tmpdir(), 'right-proj', 'attachments');

test('台账说这张图属于本会话 → 放行(救回落错目录的历史文件)', () => {
  const result = filterImagesToUploadStore(
    [{ path: strayImage, name: 'shot.png', mimeType: 'image/png' }],
    STORE,
    [sessionProjectAttachments],
    (absPath) => (absPath === strayImage ? { sessionId: 'sess-1' } : undefined),
    'sess-1',
  );
  assert.deepEqual(result.map((entry) => entry.path), [strayImage]);
});

test('台账说它属于**别的**会话 → 照旧丢掉', () => {
  // 这条是兜底的边界:兜底认的是"服务端记过账且归属本会话",不是"路径长得像附件"。
  const result = filterImagesToUploadStore(
    [{ path: strayImage }],
    STORE,
    [sessionProjectAttachments],
    () => ({ sessionId: 'someone-else' }),
    'sess-1',
  );
  assert.deepEqual(result, []);
});

test('台账里根本没有这条记录 → 丢掉(加固之前落盘的野文件不放行)', () => {
  const result = filterImagesToUploadStore(
    [{ path: strayImage }],
    STORE,
    [sessionProjectAttachments],
    () => undefined,
    'sess-1',
  );
  assert.deepEqual(result, []);
});

test('兜底只认绝对路径 —— 裸文件名不查台账', () => {
  // 裸名要靠根来解析,而"用哪个根"正是这次要消掉的歧义。
  const result = filterImagesToUploadStore(
    ['stray.png'],
    STORE,
    [sessionProjectAttachments],
    () => ({ sessionId: 'sess-1' }),
    'sess-1',
  );
  assert.deepEqual(result.map((entry) => entry.path), [path.join(STORE, 'stray.png')]);
});

test('没有 sessionId 时不启用兜底', () => {
  const result = filterImagesToUploadStore(
    [{ path: strayImage }],
    STORE,
    [sessionProjectAttachments],
    () => ({ sessionId: 'sess-1' }),
    null,
  );
  assert.deepEqual(result, []);
});

test('穿越路径即使台账认也不放行(路径先归一,再比)', () => {
  const escaped = path.join(otherProjectAttachments, '..', 'src', 'secret.png');
  const result = filterImagesToUploadStore(
    [{ path: escaped }],
    STORE,
    [sessionProjectAttachments],
    // 台账里存的是归一后的绝对路径,穿越写法查不到 —— 这正是要的行为
    (absPath) => (absPath === strayImage ? { sessionId: 'sess-1' } : undefined),
    'sess-1',
  );
  assert.deepEqual(result, []);
});

/**
 * F08:**共用目录里的图要查归属。**
 *
 * 全局图库(`~/.prism/assets`)是所有用户共用的一个目录,而这道门此前只判
 * "在不在这个目录里" —— 路径会出现在导出、日志、别人分享的截图里,
 * 知道文件名就能把**别人的图**塞进自己的对话发给模型。
 *
 * 只对全局图库查:项目内的 `attachments/` 走到这一步说明会话可见性已经过了。
 */
const sharedImage = path.join(STORE, 'someones-shot.png');

test('台账说这张图是别人的 → 丢掉', () => {
  const result = filterImagesToUploadStore(
    [{ path: sharedImage }],
    STORE,
    [],
    () => ({ userId: 42, sessionId: 'their-session' }),
    'my-session',
    7,
  );
  assert.deepEqual(result, []);
});

test('台账说是自己的(哪怕是自己**另一条**会话传的)→ 放行', () => {
  // 同一个人在别的会话里传过的图,自己再引用是正常操作(编辑重跑、复制路径)。
  const result = filterImagesToUploadStore(
    [{ path: sharedImage }],
    STORE,
    [],
    () => ({ userId: 7, sessionId: 'my-other-session' }),
    'my-session',
    7,
  );
  assert.deepEqual(result.map((entry) => entry.path), [sharedImage]);
});

test('台账里没有记录(加固之前的老文件)→ 默认放行', () => {
  // 直接拒会让老会话的编辑重跑 / 排队重放连自己的图都发不出去。
  const result = filterImagesToUploadStore(
    [{ path: sharedImage }],
    STORE,
    [],
    () => undefined,
    'my-session',
    7,
  );
  assert.deepEqual(result.map((entry) => entry.path), [sharedImage]);
});

test('PRISM_STRICT_ATTACHMENT_OWNER=1 时无主文件也拒', () => {
  const previous = process.env.PRISM_STRICT_ATTACHMENT_OWNER;
  process.env.PRISM_STRICT_ATTACHMENT_OWNER = '1';
  try {
    const result = filterImagesToUploadStore(
      [{ path: sharedImage }],
      STORE,
      [],
      () => undefined,
      'my-session',
      7,
    );
    assert.deepEqual(result, []);
  } finally {
    if (previous === undefined) delete process.env.PRISM_STRICT_ATTACHMENT_OWNER;
    else process.env.PRISM_STRICT_ATTACHMENT_OWNER = previous;
  }
});

test('项目内 attachments/ 不查归属 —— 会话可见性已经把过一道了', () => {
  const projectAttachments = path.join(os.tmpdir(), 'owner-proj', 'attachments');
  const result = filterImagesToUploadStore(
    [{ path: path.join(projectAttachments, 'shot.png') }],
    STORE,
    [projectAttachments],
    () => ({ userId: 42, sessionId: 'their-session' }),   // 台账说是别人的
    'my-session',
    7,
  );
  assert.deepEqual(result.map((entry) => entry.path), [path.join(projectAttachments, 'shot.png')]);
});

test('不传 actorUserId 时不启用归属校验(外部调用/测试维持原行为)', () => {
  const result = filterImagesToUploadStore(
    [{ path: sharedImage }],
    STORE,
    [],
    () => ({ userId: 42, sessionId: 'their-session' }),
    'my-session',
  );
  assert.deepEqual(result.map((entry) => entry.path), [sharedImage]);
});

test('台账里 user_id 为空(历史行)→ 不据此判定为别人的', () => {
  const result = filterImagesToUploadStore(
    [{ path: sharedImage }],
    STORE,
    [],
    () => ({ userId: null, sessionId: null }),
    'my-session',
    7,
  );
  assert.deepEqual(result.map((entry) => entry.path), [sharedImage]);
});
