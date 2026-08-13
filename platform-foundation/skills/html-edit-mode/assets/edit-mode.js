/* ================================================================ */
/*  EDIT MODE SCRIPT — inject into target HTML before </body>       */
/*  Self-contained IIFE. No external dependencies.                   */
/* ================================================================ */
(function() {
  'use strict';

  // ===== STATE =====
  var editMode = false;
  var changedCount = 0;          // number of modified elements
  var styleMode = false;         // block style editing mode
  var activeStyleTarget = null;  // currently selected block for style editing
  var styleEditCount = 0;        // number of block style edits

  // ===== DOM REFS =====
  var toggleBtn   = document.getElementById('toggle-btn');
  var exportBtn   = document.getElementById('export-btn');
  var undoAllBtn  = document.getElementById('undo-all-btn');
  var dlLink      = document.getElementById('download-link');
  var hintText    = document.getElementById('hint-text');
  var countBadge  = document.getElementById('changed-count');
  var toastEl     = document.getElementById('edit-toast');
  var styleBtn    = document.getElementById('style-btn');
  var floatBar    = document.getElementById('edit-float-bar');
  var fmtBold     = document.getElementById('fmt-bold');
  var fmtSize     = document.getElementById('fmt-size');
  var fmtColor    = document.getElementById('fmt-color-picker');
  var fmtSwatches = document.getElementById('fmt-swatches');
  var stylePanel  = document.getElementById('edit-style-panel');
  var espBg       = document.getElementById('esp-bg-color');
  var espBdColor  = document.getElementById('esp-bd-color');
  var espBdWidth  = document.getElementById('esp-bd-width');
  var espBdStyle  = document.getElementById('esp-bd-style');
  var espBdRadius = document.getElementById('esp-bd-radius');
  var espPadding  = document.getElementById('esp-padding');
  var espBgSwatches = document.getElementById('esp-bg-swatches');
  var espBdSwatches = document.getElementById('esp-bd-swatches');
  var espReset    = document.getElementById('esp-reset');
  var espDone     = document.getElementById('esp-done');

  // ===== EDITABLE-TAG WHITELIST =====
  var EDIT_TAGS = {
    'SPAN':1,'STRONG':1,'EM':1,'A':1,'CODE':1,'MARK':1,'SUB':1,'SUP':1,'LABEL':1,'SMALL':1,'B':1,'I':1,'U':1,
    'H1':1,'H2':1,'H3':1,'H4':1,'H5':1,'H6':1,'P':1,'LI':1,'TD':1,'TH':1
  };

  var STRUCTURAL = ['insight','chart-box','chart-canvas','container','sidebar','edit-toolbar',
    'chart-row','trend-grid','summary-grid','conclusion-grid','so-grid','key-numbers','insight-header'];

  // ===== CONFIGURABLE BLOCK TYPES =====
  // Add/remove CSS class names to control which blocks can be style-edited
  var STYLE_BLOCKS = ['masthead','summary','summary-card','section-overview','insight',
    'chart-box','trend-card','rec-box','trend-action','conclusion','action-box','conc-card'];

  // Text color presets
  var TEXT_COLORS = ['#1a1a1a','#c41e3a','#27ae60','#2980b9','#f39c12','#e74c3c','#555555','#888888'];

  // BG color presets
  var BG_COLORS = ['#ffffff','#fafafa','#faf8f5','#fef5f5','#f4fdf6','#fffdf5','#e3f2fd','#1c1c1c','#f5f3ef'];

  // Border color presets
  var BD_COLORS = ['#cccccc','#eeeeee','#dddddd','#c41e3a','#27ae60','#f39c12','#e74c3c','#2980b9','#1a1a1a'];

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CANVAS' || tag === 'IMG' || tag === 'SVG' ||
        tag === 'BR' || tag === 'HR' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return false;
    if (el.closest('.sidebar, .edit-toolbar, .edit-toast, .chart-canvas')) return false;
    if (EDIT_TAGS[tag]) return true;
    if (tag === 'DIV') {
      var cls = el.className || '';
      if (typeof cls === 'string') {
        for (var i = 0; i < STRUCTURAL.length; i++) {
          if (cls.indexOf(STRUCTURAL[i]) !== -1) return false;
        }
      }
      var txt = (el.textContent || '').trim();
      return txt.length > 0 && txt.length < 5000;
    }
    return false;
  }

  // ===== TOAST =====
  var toastTimer;
  function toast(msg) {
    if (!toastEl) return;
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    toastTimer = setTimeout(function() { toastEl.classList.remove('show'); }, 2500);
  }

  // ===== BADGE =====
  function updateUI() {
    if (changedCount > 0) {
      countBadge.textContent = '已修改 ' + changedCount + ' 处';
      countBadge.style.display = 'inline-block';
    } else {
      countBadge.style.display = 'none';
    }
    undoAllBtn.style.display = (changedCount > 0 && editMode) ? 'inline-block' : 'none';
    styleBtn.style.display = editMode ? 'inline-block' : 'none';
  }

  // ===== FIND TARGET =====
  function findTarget(el) {
    while (el && el.nodeType === 3) el = el.parentElement;
    while (el && el.nodeType === 1) {
      if (isEditable(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ===== CLICK HANDLER (capture phase) =====
  function onDocClick(e) {
    if (!editMode) return;
    if (e.altKey) return;
    if (e.target.closest && (
      e.target.closest('.edit-toolbar') ||
      e.target.closest('.edit-float-bar') ||
      e.target.closest('.edit-style-panel')
    )) return;

    // Style mode: clicking a stylable block selects it
    if (styleMode) {
      var block = e.target.closest ? e.target.closest('.block-stylable') : null;
      if (block) {
        e.preventDefault();
        e.stopPropagation();
        selectBlock(block);
        return;
      }
      if (!e.target.closest('.edit-style-panel')) {
        deselectBlock();
        hideStylePanel();
      }
      return;
    }

    var cur = document.querySelector('[contenteditable="true"]');
    if (cur && cur.contains(e.target)) return;
    if (cur) finishEdit(cur);

    var tgt = findTarget(e.target);
    if (!tgt) return;

    e.preventDefault();
    e.stopPropagation();

    // Save ORIGINAL on FIRST edit (never overwritten)
    if (!tgt.hasAttribute('data-orig')) {
      tgt.setAttribute('data-orig', tgt.innerHTML);
    }
    tgt.setAttribute('contenteditable', 'true');
    tgt.classList.add('editing-now');
    tgt.focus();
    try {
      var r = document.createRange();
      r.selectNodeContents(tgt);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } catch(ignore) {}
    setTimeout(function() { showFloatBar(tgt); }, 60);
  }

  // ===== FINISH EDIT =====
  function finishEdit(el) {
    if (!el) return;
    hideFloatBar();
    el.removeAttribute('contenteditable');
    el.classList.remove('editing-now');

    var orig = el.getAttribute('data-orig');
    var now  = el.innerHTML;
    if (orig !== null && now !== orig) {
      if (!el.hasAttribute('data-edited')) {
        el.setAttribute('data-edited', '1');
        changedCount++;
      }
      el.classList.add('edited-saved');
      setTimeout(function() { el.classList.remove('edited-saved'); }, 700);
    }
    if (orig !== null && now === orig && el.hasAttribute('data-edited')) {
      el.removeAttribute('data-edited');
      changedCount = Math.max(0, changedCount - 1);
    }
    updateUI();
  }

  // ===== FOCUSOUT =====
  function onFocusOut(e) {
    var el = e.target;
    if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
      setTimeout(function() {
        if (el.getAttribute('contenteditable') !== 'true') return;
        if (document.activeElement && document.activeElement.closest && (
          document.activeElement.closest('.edit-toolbar') ||
          document.activeElement.closest('.edit-float-bar')
        )) return;
        finishEdit(el);
      }, 100);
    }
  }

  // ===== KEYBOARD =====
  function onKeyDown(e) {
    if (!editMode) return;
    var el = document.activeElement;
    if (!el || el.getAttribute('contenteditable') !== 'true') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      var orig = el.getAttribute('data-orig');
      if (orig !== null) el.innerHTML = orig;
      el.removeAttribute('contenteditable');
      el.classList.remove('editing-now');
      el.blur();
      hideFloatBar();
      toast('已取消编辑');
    }
  }

  // ===== FLOAT TEXT FORMAT BAR =====
  function buildTextSwatches() {
    for (var i = 0; i < TEXT_COLORS.length; i++) {
      var sw = document.createElement('span');
      sw.className = 'fmt-swatch';
      sw.style.backgroundColor = TEXT_COLORS[i];
      sw.setAttribute('data-color', TEXT_COLORS[i]);
      sw.title = TEXT_COLORS[i];
      sw.addEventListener('mousedown', function(e) {
        e.preventDefault();
        var color = this.getAttribute('data-color');
        applyFontColor(color);
        var all = fmtSwatches.querySelectorAll('.fmt-swatch');
        for (var j = 0; j < all.length; j++) all[j].classList.remove('sel');
        this.classList.add('sel');
      });
      fmtSwatches.appendChild(sw);
    }
  }

  function showFloatBar(el) {
    if (!el || !floatBar) return;
    positionFloatBar(el);
    floatBar.classList.add('visible');
    updateBoldState();
    fmtSize.value = '';
  }

  function hideFloatBar() {
    if (floatBar) floatBar.classList.remove('visible');
  }

  function positionFloatBar(el) {
    var rect = el.getBoundingClientRect();
    var barH = floatBar.offsetHeight || 38;
    var barW = floatBar.offsetWidth || 300;
    var left = rect.left + window.scrollX;
    var top = rect.top + window.scrollY - barH - 8;
    if (top < window.scrollY + 8) {
      top = rect.bottom + window.scrollY + 8;
    }
    if (left + barW > window.innerWidth + window.scrollX - 20) {
      left = window.innerWidth + window.scrollX - barW - 20;
    }
    if (left < window.scrollX + 8) left = window.scrollX + 8;
    floatBar.style.left = left + 'px';
    floatBar.style.top  = top + 'px';
  }

  function applyBold() {
    var el = document.querySelector('[contenteditable="true"]');
    if (!el) return;
    el.focus();
    document.execCommand('bold', false, null);
    updateBoldState();
  }

  function updateBoldState() {
    if (document.queryCommandState('bold')) {
      fmtBold.classList.add('active');
    } else {
      fmtBold.classList.remove('active');
    }
  }

  function applyFontSize(size) {
    var el = document.querySelector('[contenteditable="true"]');
    if (!el) return;
    el.focus();
    var sel = window.getSelection();
    if (!sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    if (range.collapsed) return;

    var span = document.createElement('span');
    span.style.fontSize = size + 'px';

    try {
      range.surroundContents(span);
    } catch(e) {
      var frag = range.extractContents();
      var oldSpans = frag.querySelectorAll ? frag.querySelectorAll('span[style*="font-size"]') : [];
      for (var k = 0; k < oldSpans.length; k++) {
        var os = oldSpans[k];
        while (os.firstChild) os.parentNode.insertBefore(os.firstChild, os);
        os.parentNode.removeChild(os);
      }
      span.appendChild(frag);
      range.insertNode(span);
    }

    sel.removeAllRanges();
  }

  function applyFontColor(color) {
    var el = document.querySelector('[contenteditable="true"]');
    if (!el) return;
    el.focus();
    document.execCommand('foreColor', false, color);
  }

  // ===== BLOCK STYLE EDITING =====

  function isStylableBlock(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest && el.closest('.edit-toolbar,.sidebar,.edit-toast,.edit-float-bar,.edit-style-panel')) return false;
    var cls = (typeof el.className === 'string') ? el.className : '';
    for (var i = 0; i < STYLE_BLOCKS.length; i++) {
      if (cls.indexOf(STYLE_BLOCKS[i]) !== -1) return true;
    }
    return false;
  }

  function markStylableBlocks() {
    var all = document.querySelectorAll('.masthead, .container');
    for (var c = 0; c < all.length; c++) {
      var walker = document.createTreeWalker(all[c], NodeFilter.SHOW_ELEMENT, {
        acceptNode: function(node) {
          if (node.closest('.sidebar,.edit-toolbar')) return NodeFilter.FILTER_REJECT;
          if (isStylableBlock(node)) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        }
      });
      while (walker.nextNode()) {
        walker.currentNode.classList.add('block-stylable');
      }
    }
  }

  function unmarkStylableBlocks() {
    var blocks = document.querySelectorAll('.block-stylable');
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].classList.remove('block-stylable');
    }
  }

  function toggleStyleMode() {
    styleMode = !styleMode;
    if (styleMode) {
      document.body.classList.add('style-mode-active');
      styleBtn.classList.add('active');
      styleBtn.textContent = '🔧 退出块样式';
      markStylableBlocks();
      var cur = document.querySelector('[contenteditable="true"]');
      if (cur) finishEdit(cur);
      hideFloatBar();
      toast('块样式模式已开启 · 点击模块进行样式编辑');
    } else {
      document.body.classList.remove('style-mode-active');
      styleBtn.classList.remove('active');
      styleBtn.textContent = '🎨 块样式';
      unmarkStylableBlocks();
      deselectBlock();
      hideStylePanel();
      toast('块样式模式已关闭');
    }
  }

  function deselectBlock() {
    if (activeStyleTarget) {
      activeStyleTarget.classList.remove('block-selected');
      activeStyleTarget = null;
    }
  }

  function selectBlock(block) {
    deselectBlock();
    activeStyleTarget = block;
    block.classList.add('block-selected');
    readBlockStyle(block);
    showStylePanel();
  }

  function showStylePanel() {
    if (stylePanel) stylePanel.classList.add('visible');
  }

  function hideStylePanel() {
    if (stylePanel) stylePanel.classList.remove('visible');
  }

  function rgbToHex(rgb) {
    if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') return '';
    if (rgb.charAt(0) === '#') return rgb;
    var m = rgb.match(/[\d.]+/g);
    if (!m || m.length < 3) return '';
    var r = parseInt(m[0]), g = parseInt(m[1]), b = parseInt(m[2]);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  function readBlockStyle(block) {
    var cs = window.getComputedStyle(block);
    espBg.value       = rgbToHex(cs.backgroundColor) || '#ffffff';
    espBdColor.value  = rgbToHex(cs.borderLeftColor) || '#cccccc';
    espBdWidth.value  = parseFloat(cs.borderLeftWidth) ? parseFloat(cs.borderLeftWidth) + 'px' : '';
    espBdStyle.value  = cs.borderLeftStyle !== 'none' ? cs.borderLeftStyle : '';
    espBdRadius.value = parseFloat(cs.borderRadius) ? parseFloat(cs.borderRadius) + 'px' : '';
    espPadding.value  = parseFloat(cs.paddingLeft) ? parseFloat(cs.paddingLeft) + 'px' : '';
    highlightBlockSwatch(espBgSwatches, espBg.value);
    highlightBlockSwatch(espBdSwatches, espBdColor.value);
  }

  function highlightBlockSwatch(container, color) {
    var sw = container.querySelectorAll('.esp-swatch');
    for (var i = 0; i < sw.length; i++) {
      sw[i].classList.remove('sel');
      if (sw[i].getAttribute('data-color') === color) sw[i].classList.add('sel');
    }
  }

  function applyBlockStyle(prop, value) {
    if (!activeStyleTarget) return;
    if (!activeStyleTarget.hasAttribute('data-orig-style')) {
      activeStyleTarget.setAttribute('data-orig-style', JSON.stringify({
        cssText: activeStyleTarget.style.cssText || ''
      }));
    }
    if (value === '' || value === null) {
      activeStyleTarget.style.removeProperty(prop);
    } else {
      activeStyleTarget.style.setProperty(prop, value);
    }
    if (!activeStyleTarget.hasAttribute('data-style-edited')) {
      activeStyleTarget.setAttribute('data-style-edited', '1');
      styleEditCount++;
      changedCount++;
      updateUI();
    }
  }

  function resetBlockStyle() {
    if (!activeStyleTarget) return;
    var orig = activeStyleTarget.getAttribute('data-orig-style');
    if (orig !== null) {
      try {
        var data = JSON.parse(orig);
        activeStyleTarget.style.cssText = data.cssText;
      } catch(e) {
        activeStyleTarget.removeAttribute('style');
      }
    } else {
      activeStyleTarget.removeAttribute('style');
    }
    activeStyleTarget.removeAttribute('data-orig-style');
    if (activeStyleTarget.hasAttribute('data-style-edited')) {
      activeStyleTarget.removeAttribute('data-style-edited');
      styleEditCount = Math.max(0, styleEditCount - 1);
      changedCount = Math.max(0, changedCount - 1);
    }
    updateUI();
    readBlockStyle(activeStyleTarget);
    toast('已重置块样式');
  }

  function buildBlockSwatches(container, colors, onChangeFn) {
    for (var i = 0; i < colors.length; i++) {
      (function(color) {
        var sw = document.createElement('span');
        sw.className = 'esp-swatch';
        sw.style.backgroundColor = color;
        sw.setAttribute('data-color', color);
        sw.title = color;
        sw.addEventListener('click', function() {
          onChangeFn(color);
          highlightBlockSwatch(container, color);
        });
        container.appendChild(sw);
      })(colors[i]);
    }
  }

  // ===== TOGGLE EDIT MODE =====
  function toggleEditMode() {
    editMode = !editMode;
    if (editMode) {
      document.body.classList.add('edit-mode');
      toggleBtn.textContent = '🔓 退出编辑';
      toggleBtn.classList.add('active');
      exportBtn.style.display = 'inline-block';
      hintText.style.display = 'inline';
      updateUI();
      toast('编辑模式已开启 · 点击任意文字即可修改');
    } else {
      var cur = document.querySelector('[contenteditable="true"]');
      if (cur) finishEdit(cur);
      if (styleMode) {
        styleMode = false;
        document.body.classList.remove('style-mode-active');
        styleBtn.classList.remove('active');
        styleBtn.textContent = '🎨 块样式';
        unmarkStylableBlocks();
        deselectBlock();
        hideStylePanel();
      }
      document.body.classList.remove('edit-mode');
      toggleBtn.textContent = '✏️ 开启编辑';
      toggleBtn.classList.remove('active');
      exportBtn.style.display = 'none';
      dlLink.style.display = 'none';
      undoAllBtn.style.display = 'none';
      styleBtn.style.display = 'none';
      hintText.style.display = 'none';
      hideFloatBar();
    }
  }

  // ===== UNDO ONE ELEMENT =====
  function undoOne(el) {
    // Handle block style undo
    if (el.hasAttribute('data-style-edited')) {
      var origStyle = el.getAttribute('data-orig-style');
      if (origStyle !== null) {
        try {
          var data = JSON.parse(origStyle);
          el.style.cssText = data.cssText;
        } catch(e) {
          el.removeAttribute('style');
        }
      } else {
        el.removeAttribute('style');
      }
      el.removeAttribute('data-orig-style');
      el.removeAttribute('data-style-edited');
      styleEditCount = Math.max(0, styleEditCount - 1);
      changedCount = Math.max(0, changedCount - 1);
      el.classList.add('edited-saved');
      setTimeout(function() { el.classList.remove('edited-saved'); }, 700);
      updateUI();
      return;
    }
    // Handle text undo
    var orig = el.getAttribute('data-orig');
    if (orig === null) return;
    el.innerHTML = orig;
    if (el.hasAttribute('data-edited')) {
      el.removeAttribute('data-edited');
      changedCount = Math.max(0, changedCount - 1);
    }
    el.classList.add('edited-saved');
    setTimeout(function() { el.classList.remove('edited-saved'); }, 700);
    updateUI();
  }

  // ===== UNDO ALL =====
  function undoAll() {
    var total = 0;
    // Undo text edits
    var edited = document.querySelectorAll('[data-edited]');
    for (var i = 0; i < edited.length; i++) {
      var orig = edited[i].getAttribute('data-orig');
      if (orig !== null) {
        edited[i].innerHTML = orig;
        edited[i].removeAttribute('data-edited');
        total++;
      }
    }
    // Undo block style edits
    var styled = document.querySelectorAll('[data-style-edited]');
    for (var j = 0; j < styled.length; j++) {
      var origStyle = styled[j].getAttribute('data-orig-style');
      if (origStyle !== null) {
        try {
          var data = JSON.parse(origStyle);
          styled[j].style.cssText = data.cssText;
        } catch(e) {
          styled[j].removeAttribute('style');
        }
      } else {
        styled[j].removeAttribute('style');
      }
      styled[j].removeAttribute('data-orig-style');
      styled[j].removeAttribute('data-style-edited');
      total++;
    }
    changedCount = 0;
    styleEditCount = 0;
    updateUI();
    toast('已撤销全部 ' + total + ' 处修改');
  }

  // ===== EXPORT =====
  function utf8ToBase64(str) {
    var encoded = encodeURIComponent(str);
    var binary  = '';
    for (var i = 0; i < encoded.length; i++) {
      var c = encoded.charAt(i);
      if (c === '%') {
        var hex = encoded.charAt(i + 1) + encoded.charAt(i + 2);
        binary += String.fromCharCode(parseInt(hex, 16));
        i += 2;
      } else {
        binary += c;
      }
    }
    return btoa(binary);
  }

  function buildHelperPage(b64Html, filename, sizeKb) {
    return '<!DOCTYPE html>\n' +
'<html lang="zh-CN">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>导出报告 · ' + filename.replace(/\.html$/, '') + '</title>\n' +
'<style>\n' +
'*{margin:0;padding:0;box-sizing:border-box}\n' +
'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
'background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);min-height:100vh;' +
'display:flex;align-items:center;justify-content:center;color:#e0e0e0}\n' +
'.card{background:rgba(255,255,255,0.05);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);' +
'border-radius:20px;padding:48px 56px;max-width:560px;width:90%;' +
'border:1px solid rgba(255,255,255,0.12);text-align:center;' +
'box-shadow:0 24px 80px rgba(0,0,0,0.5)}\n' +
'.icon{font-size:72px;margin-bottom:20px;display:block}\n' +
'h2{color:#fff;font-size:26px;font-weight:700;margin-bottom:12px;letter-spacing:-0.5px}\n' +
'.meta{color:rgba(255,255,255,0.55);font-size:14px;margin-bottom:8px;line-height:1.6}\n' +
'.dl-btn{display:inline-flex;align-items:center;gap:8px;margin-top:28px;' +
'padding:16px 44px;background:linear-gradient(135deg,#2563eb,#3b82f6);' +
'color:#fff;border-radius:12px;text-decoration:none;font-size:17px;font-weight:600;' +
'box-shadow:0 4px 24px rgba(37,99,235,0.45);' +
'transition:transform 0.2s,box-shadow 0.2s;cursor:pointer;border:none}\n' +
'.dl-btn:hover{transform:translateY(-2px);box-shadow:0 8px 32px rgba(37,99,235,0.6)}\n' +
'.dl-btn:active{transform:translateY(0)}\n' +
'.hint{color:rgba(255,255,255,0.4);margin-top:24px;font-size:13px;line-height:1.7}\n' +
'.size-badge{display:inline-block;padding:4px 14px;background:rgba(255,255,255,0.08);' +
'border-radius:20px;font-size:13px;color:rgba(255,255,255,0.7);margin-top:8px}\n' +
'.status{color:#10b981;font-size:14px;margin-top:16px;display:none}\n' +
'.status.show{display:block}\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'<div class="card">\n' +
'<span class="icon">📄</span>\n' +
'<h2>报告导出就绪</h2>\n' +
'<p class="meta">已生成编辑后的报告文件，点击下方按钮即可下载保存到本地。</p>\n' +
'<span class="size-badge">文件大小: ' + sizeKb + ' KB · ' + filename + '</span>\n' +
'<a class="dl-btn" id="dl-btn" href="#">⬇️ 下载 HTML 文件</a>\n' +
'<p class="status" id="status">✅ 下载已开始 · 如未开始请点击上方按钮</p>\n' +
'<p class="hint">💡 提示：点击按钮后浏览器将自动下载<br>下载完成后即可关闭此页面</p>\n' +
'</div>\n' +
'<script>\n' +
'(function() {\n' +
'  var b64 = ' + JSON.stringify(b64Html) + ';\n' +
'  var filename = ' + JSON.stringify(filename) + ';\n' +
'  var binary = atob(b64);\n' +
'  var encoded = "";\n' +
'  for (var i = 0; i < binary.length; i++) {\n' +
'    var hex = binary.charCodeAt(i).toString(16);\n' +
'    encoded += "%" + (hex.length === 1 ? "0" : "") + hex;\n' +
'  }\n' +
'  var html = decodeURIComponent(encoded);\n' +
'  var blob = new Blob([html], { type: "text/html;charset=UTF-8" });\n' +
'  var url = URL.createObjectURL(blob);\n' +
'  var btn = document.getElementById("dl-btn");\n' +
'  btn.href = url;\n' +
'  btn.setAttribute("download", filename);\n' +
'  setTimeout(function() {\n' +
'    btn.click();\n' +
'    setTimeout(function() {\n' +
'      document.getElementById("status").classList.add("show");\n' +
'    }, 500);\n' +
'  }, 400);\n' +
'  btn.addEventListener("click", function() {\n' +
'    document.getElementById("status").classList.add("show");\n' +
'  });\n' +
'})();\n' +
'<\/script>\n' +
'</body>\n' +
'</html>';
  }

  function doExport() {
    var cur = document.querySelector('[contenteditable="true"]');
    if (cur) finishEdit(cur);

    var clone = document.documentElement.cloneNode(true);

    // Strip edit artifacts from clone
    var rm = clone.querySelectorAll('#edit-toolbar, #edit-toast, #edit-float-bar, #edit-style-panel');
    for (var i = 0; i < rm.length; i++) {
      if (rm[i].parentNode) rm[i].parentNode.removeChild(rm[i]);
    }
    var scripts = clone.querySelectorAll('script');
    for (var s = 0; s < scripts.length; s++) {
      if (scripts[s].textContent.indexOf('EDIT MODE SCRIPT') !== -1) {
        scripts[s].parentNode.removeChild(scripts[s]);
        break;
      }
    }
    var attrs = clone.querySelectorAll('[contenteditable],[data-editable],[data-orig],[data-edited],[data-orig-style],[data-style-edited]');
    for (var j = 0; j < attrs.length; j++) {
      attrs[j].removeAttribute('contenteditable');
      attrs[j].removeAttribute('data-editable');
      attrs[j].removeAttribute('data-orig');
      attrs[j].removeAttribute('data-edited');
      attrs[j].removeAttribute('data-orig-style');
      attrs[j].removeAttribute('data-style-edited');
    }
    var clsEls = clone.querySelectorAll('.editing-now,.edited-saved,.block-stylable,.block-selected');
    for (var k = 0; k < clsEls.length; k++) {
      clsEls[k].classList.remove('editing-now');
      clsEls[k].classList.remove('edited-saved');
      clsEls[k].classList.remove('block-stylable');
      clsEls[k].classList.remove('block-selected');
    }
    var bd = clone.querySelector('body');
    if (bd) { bd.classList.remove('edit-mode'); bd.classList.remove('style-mode-active'); }

    var html = '<!DOCTYPE html>\n' + clone.outerHTML;

    var n = new Date();
    var filename = 'report_edited_' +
      n.getFullYear() +
      ('0'+(n.getMonth()+1)).slice(-2) +
      ('0'+n.getDate()).slice(-2) + '_' +
      ('0'+n.getHours()).slice(-2) +
      ('0'+n.getMinutes()).slice(-2) + '.html';

    var sizeKb = (new Blob([html]).size / 1024).toFixed(1);

    try {
      var b64Html = utf8ToBase64(html);
      var helperHtml = buildHelperPage(b64Html, filename, sizeKb);
      var w = window.open('about:blank', '_blank');
      if (w) {
        w.document.write(helperHtml);
        w.document.close();
        toast('✅ 已打开下载页面，点击下载按钮即可保存文件');
        return;
      }
      throw new Error('POPUP_BLOCKED');
    } catch(err) {
      try {
        var blob = new Blob([html], { type: 'text/html;charset=UTF-8' });
        var blobUrl = URL.createObjectURL(blob);
        dlLink.href = blobUrl;
        dlLink.setAttribute('download', filename);
        dlLink.style.display = 'inline-block';
        exportBtn.style.display = 'none';
        var msg = err.message === 'POPUP_BLOCKED'
          ? '👆 弹窗被拦截，请点击绿色按钮保存文件'
          : '👆 请点击绿色按钮保存文件';
        toast(msg);
        var onDlClick = function() {
          setTimeout(function() {
            dlLink.style.display = 'none';
            dlLink.removeAttribute('href');
            dlLink.removeAttribute('download');
            dlLink.removeEventListener('click', onDlClick);
            exportBtn.style.display = 'inline-block';
            URL.revokeObjectURL(blobUrl);
          }, 800);
        };
        dlLink.addEventListener('click', onDlClick);
        setTimeout(function() {
          if (dlLink.style.display !== 'none') {
            dlLink.style.display = 'none';
            exportBtn.style.display = 'inline-block';
            dlLink.removeEventListener('click', onDlClick);
          }
        }, 60000);
      } catch(err2) {
        toast('❌ 导出失败: ' + err2.message);
      }
    }
  }

  // ===== ALT+CLICK UNDO =====
  function onDocAuxClick(e) {
    if (!editMode) return;
    if (!e.altKey) return;
    var styledBlock = e.target.closest ? e.target.closest('[data-style-edited]') : null;
    if (styledBlock) {
      e.preventDefault();
      e.stopPropagation();
      undoOne(styledBlock);
      toast('已撤销此项样式修改');
      return;
    }
    var tgt = findTarget(e.target);
    if (!tgt) return;
    if (!tgt.hasAttribute('data-edited')) return;
    e.preventDefault();
    e.stopPropagation();
    undoOne(tgt);
    toast('已撤销此项修改');
  }

  // ===== REMARK EDITABLE =====
  function remarkEditable() {
    var containers = document.querySelectorAll('.masthead, .container');
    for (var c = 0; c < containers.length; c++) {
      var walker = document.createTreeWalker(containers[c], NodeFilter.SHOW_ELEMENT, {
        acceptNode: function(node) {
          if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'CANVAS') return NodeFilter.FILTER_REJECT;
          if (node.closest && (node.closest('.sidebar') || node.closest('.edit-toolbar') || node.closest('.chart-canvas'))) return NodeFilter.FILTER_REJECT;
          if (EDIT_TAGS[node.tagName]) return NodeFilter.FILTER_ACCEPT;
          if (node.tagName === 'DIV') {
            var cls = node.className || '';
            if (typeof cls === 'string') {
              for (var i = 0; i < STRUCTURAL.length; i++) {
                if (cls.indexOf(STRUCTURAL[i]) !== -1) return NodeFilter.FILTER_REJECT;
              }
            }
            var txt = (node.textContent || '').trim();
            if (txt.length > 0 && txt.length < 5000) return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        }
      });
      while (walker.nextNode()) {
        if (!walker.currentNode.hasAttribute('data-editable')) {
          walker.currentNode.setAttribute('data-editable', '');
        }
      }
    }
  }

  // ===== BUTTON BINDINGS =====
  toggleBtn.addEventListener('click', function(e) {
    e.preventDefault();
    toggleEditMode();
  });

  exportBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    doExport();
  });

  undoAllBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    undoAll();
  });

  styleBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    toggleStyleMode();
  });

  // ===== FLOAT BAR BUTTON BINDINGS =====
  fmtBold.addEventListener('mousedown', function(e) {
    e.preventDefault();
    applyBold();
  });

  fmtSize.addEventListener('change', function() {
    var val = this.value;
    if (val) applyFontSize(val);
    this.value = '';
  });

  fmtColor.addEventListener('input', function() {
    applyFontColor(this.value);
  });

  document.addEventListener('selectionchange', function() {
    if (!editMode || styleMode) return;
    var el = document.querySelector('[contenteditable="true"]');
    if (!el || !document.activeElement || !el.contains(document.activeElement)) return;
    updateBoldState();
  });

  // ===== BLOCK STYLE PANEL BINDINGS =====
  espBg.addEventListener('input', function() {
    applyBlockStyle('background-color', this.value);
    highlightBlockSwatch(espBgSwatches, this.value);
  });
  espBdColor.addEventListener('input', function() {
    applyBlockStyle('border-color', this.value);
    highlightBlockSwatch(espBdSwatches, this.value);
  });
  espBdWidth.addEventListener('input', function() {
    applyBlockStyle('border-width', this.value.trim() || null);
  });
  espBdStyle.addEventListener('change', function() {
    applyBlockStyle('border-style', this.value || null);
  });
  espBdRadius.addEventListener('input', function() {
    applyBlockStyle('border-radius', this.value.trim() || null);
  });
  espPadding.addEventListener('input', function() {
    applyBlockStyle('padding', this.value.trim() || null);
  });
  espReset.addEventListener('click', function(e) {
    e.preventDefault();
    resetBlockStyle();
  });
  espDone.addEventListener('click', function(e) {
    e.preventDefault();
    if (styleMode) toggleStyleMode();
  });

  // Prevent mousedown on float bar buttons from stealing focus (but NOT on selects/inputs)
  floatBar.addEventListener('mousedown', function(e) {
    if (e.target.tagName === 'BUTTON') e.preventDefault();
  });
  stylePanel.addEventListener('mousedown', function(e) { e.stopPropagation(); });

  // Reposition float bar on scroll/resize
  window.addEventListener('scroll', function() {
    if (floatBar.classList.contains('visible')) {
      var el = document.querySelector('[contenteditable="true"]');
      if (el) positionFloatBar(el);
    }
  }, true);

  window.addEventListener('resize', function() {
    if (floatBar.classList.contains('visible')) {
      var el = document.querySelector('[contenteditable="true"]');
      if (el) positionFloatBar(el);
    }
  });

  // ===== GLOBAL LISTENERS =====
  document.addEventListener('click',  onDocClick,    true);
  document.addEventListener('click',  onDocAuxClick, true);
  document.addEventListener('focusout', onFocusOut,  true);
  document.addEventListener('keydown', onKeyDown,    true);

  // ===== INIT =====
  buildTextSwatches();
  buildBlockSwatches(espBgSwatches, BG_COLORS, function(color) {
    espBg.value = color;
    applyBlockStyle('background-color', color);
    highlightBlockSwatch(espBgSwatches, color);
  });
  buildBlockSwatches(espBdSwatches, BD_COLORS, function(color) {
    espBdColor.value = color;
    applyBlockStyle('border-color', color);
    highlightBlockSwatch(espBdSwatches, color);
  });
  remarkEditable();

})();
