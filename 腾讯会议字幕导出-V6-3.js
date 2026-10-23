// ==UserScript==
// @name         腾讯会议字幕导出
// @namespace    http://tampermonkey.net/
// @version      6.3
// @description  增量读取 + 自适应滚动 + 多格式导出(SRT/VTT/TXT/MD/JSON/CSV) + 「更多格式」收纳 + 预览/设置 + 可拖拽可折叠面板。修复 UTC 文件名、时间溢出、脏数据等问题。
// @match        https://meeting.tencent.com/cw/*
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-idle
// @downloadURL  
// @updateURL    
// @license      MIT
// ==/UserScript==
(function () {
'use strict';

/* ============================================================
 * 一、配置区：页面结构变了只改这里
 * ============================================================ */
const CONFIG = {
  // 容器选择器（按优先级尝试，抗前端改版）
  containerSelectors: [
    '.minutes-module-list',
    '[class*="minutes-module-list"]',
    '[class*="minutes-module"][class*="list"]'
  ],
  pidAttr: 'data-pid',
  sidAttr: 'data-sid',
  timeAttr: 'data-time-offset',

  // 词节点选择器：精确类优先，避免昂贵的属性子串匹配
  wordSelectors: ['.word-module_word', '[class*="word-module_word"]', '[class*="word-module"]'],

  // 说话人选择器（提取开关在下方 DEFAULTS.includeSpeaker，默认关闭；抓不到就留空）
  speakerSelectors: [
    '[class*="speaker"]', '[class*="Speaker"]',
    '[class*="nick"]', '[class*="user-name"]', '[class*="userName"]'
  ],

  // 滚动与等待策略
  scrollStepRatio: 0.75,   // 一次滚 0.75 屏，保留重叠区防止漏数据
  minDelay: 120,           // 读到新内容 → 快速推进
  idleDelay: 400,          // 没读到新内容 → 退避等待
  bottomIdleRounds: 3,     // 到底后连续 N 轮无新增才收尾
  maxTotalTime: 180000,    // 总超时保护，防止无限循环
  blockUpwardScroll: true, // 阻止列表自动回滚（虚拟列表场景；若你的列表向上懒加载请设为 false）

  // 注入检测
  detectDebounce: 300,
  detectMaxTries: 60,      // 约 18 秒后放弃，不再常驻 observer 空转

  // 输出
  srtWithSpeaker: false,   // SRT 是否前置"说话人："
  previewMaxLines: 200,    // 预览最大显示行数
  DEBUG: false
};

/* ------------------------------------------------------------
 * 用户偏好（持久化到 GM_setValue，可在「设置」里改）
 * ------------------------------------------------------------ */
const DEFAULTS = {
  txtMergeParagraph: false, // TXT/MD 按段落合并（关闭则一句一行）
  txtWithTime: false,       // TXT 每行前加时间戳
  includeSpeaker: false,    // 提取说话人
  useGMDownload: false,     // 使用 GM_download（大文件更省内存）
  panelCollapsed: false,
  panelPos: null            // {x, y}
};
// 只有这四项是「设置」里的用户开关，重置时仅回滚它们，不动面板位置与折叠态
const OPT_KEYS = ['txtMergeParagraph', 'txtWithTime', 'includeSpeaker', 'useGMDownload'];
const OPT_KEY = 'sex_opts';

function loadOpts() {
  try {
    if (typeof GM_getValue === 'function') {
      const raw = GM_getValue(OPT_KEY, null);
      const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return (v && typeof v === 'object') ? v : {};
    }
  } catch (e) {}
  return {};
}
function saveOpts() {
  try { if (typeof GM_setValue === 'function') GM_setValue(OPT_KEY, JSON.stringify(opts)); } catch (e) {}
}
const opts = Object.assign({}, DEFAULTS, loadOpts());

/* ============================================================
 * 二、全局状态
 * ============================================================ */
const STYLE_ID = 'sex-style-v61';
const PANEL_ID = 'srt-exporter-container';

let appContext = null;      // 字幕所在的 document（可能是 iframe 内）
let container = null;       // 滚动容器
let uiInjected = false;

let reading = false;
let stopRequested = false;
let gen = 0;                // generation token：防止旧回调写入新结果
let timerId = null;

let subtitles = [];         // {pid, sid, speaker, text, timeOffset}
let seenParagraphs = null;  // WeakSet，增量去重
let activeWordSelector = null;
let activeSpeakerSelector = null;

const ui = {};

const log = (...a) => { if (CONFIG.DEBUG) console.log('[字幕导出]', ...a); };
const p2 = n => (n < 10 ? '0' + n : '' + n);
const p3 = n => (n < 100 ? ('00' + n).slice(-3) : '' + n);

/* ============================================================
 * 三、样式
 * ============================================================ */
const CSS = `
#${PANEL_ID}{position:fixed;z-index:2147483000;background:#fff;color:#1f2328;
border:1px solid rgba(0,0,0,.12);border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.18);
font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
width:182px;overflow:hidden;user-select:none}
#${PANEL_ID}.sex-dark{background:#25262b;color:#e9ecef;border-color:rgba(255,255,255,.14)}
#sex-header{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;
cursor:move;font-weight:600;background:rgba(0,0,0,.04)}
#${PANEL_ID}.sex-dark #sex-header{background:rgba(255,255,255,.07)}
#sex-toggle{border:none;background:transparent;cursor:pointer;font-size:14px;line-height:1;
padding:2px 4px;color:inherit;opacity:.65}
#sex-body{padding:10px}
.sex-btn{display:block;width:100%;padding:8px 10px;margin-bottom:6px;border:none;border-radius:6px;
background:#007bff;color:#fff;font-size:13px;cursor:pointer;font-family:inherit}
.sex-btn:hover{filter:brightness(1.08)}
.sex-btn:disabled{background:#adb5bd;cursor:default;filter:none}
.sex-btn.alt{background:#17a2b8}
.sex-btn.ghost{background:#e9ecef;color:#495057}
.sex-btn.danger{background:#dc3545}
#${PANEL_ID}.sex-dark .sex-btn.ghost{background:#343a40;color:#e9ecef}
#sex-select{width:100%;padding:6px 8px;margin-bottom:6px;border-radius:6px;
border:1px solid rgba(0,0,0,.15);background:#fff;color:#1f2328;font-size:13px;font-family:inherit}
#${PANEL_ID}.sex-dark #sex-select{background:#2c2e33;color:#e9ecef;border-color:rgba(255,255,255,.16)}
#sex-status{font-size:12px;color:#6c757d;margin-top:8px;line-height:1.6}
#${PANEL_ID}.sex-dark #sex-status{color:#adb5bd}
#sex-progress{display:none;margin-top:8px}
#sex-bar{width:100%;height:6px;background:#e9ecef;border-radius:3px;overflow:hidden}
#${PANEL_ID}.sex-dark #sex-bar{background:#3a3d44}
#sex-fill{width:0%;height:100%;background:#4caf50;transition:width .18s linear}
#sex-text{font-size:11px;color:#6c757d;margin-top:4px}
#${PANEL_ID}.sex-dark #sex-text{color:#adb5bd}
#sex-toast{position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:2147483001;
background:rgba(28,28,30,.92);color:#fff;padding:8px 14px;border-radius:6px;font-size:13px;
opacity:0;transition:opacity .25s;pointer-events:none;max-width:70vw}
#sex-toast.show{opacity:1}
#sex-modal{position:fixed;inset:0;z-index:2147483002;background:rgba(0,0,0,.45);
display:flex;align-items:center;justify-content:center}
#sex-modal-inner{background:#fff;color:#1f2328;border-radius:10px;width:min(660px,86vw);max-height:76vh;
display:flex;flex-direction:column;padding:14px 16px;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.3);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
#sex-modal-inner.sex-dark{background:#25262b;color:#e9ecef}
#sex-modal-inner h3{margin:0 0 4px;font-size:15px;font-weight:600}
#sex-modal-inner pre{flex:1;overflow:auto;white-space:pre-wrap;word-break:break-all;
background:rgba(0,0,0,.05);padding:10px;border-radius:6px;margin:10px 0;font-size:12px;line-height:1.6}
#sex-modal-inner.sex-dark pre{background:rgba(255,255,255,.08)}
#sex-modal-inner label{display:flex;align-items:center;gap:8px;margin:7px 0;cursor:pointer}
#sex-tip{font-size:12px;color:#6c757d;line-height:1.6;margin-top:10px}
#sex-modal-inner.sex-dark #sex-tip{color:#adb5bd}
#sex-modal-inner .sex-btn{margin:10px 0 0}
`;

/* ============================================================
 * 四、工具函数
 * ============================================================ */

// 纯算术时间戳：比 new Date() 省 2n 次分配，且不受 24 小时回绕影响
function fmtTime(ms, sep) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const msec = Math.floor(ms % 1000);
  return p2(h) + ':' + p2(m) + ':' + p2(s) + sep + p3(msec);
}
const fmtSRT = ms => fmtTime(ms, ',');
const fmtVTT = ms => fmtTime(ms, '.');
function fmtClock(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
}

// 严格校验，脏数据直接丢弃而不是生成 NaN-NaN
function parseTimeOffset(raw) {
  if (!raw) return null;
  const parts = String(raw).split('-');
  const start = parseInt(parts[0], 10);
  const end = parseInt(parts[1], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end < start) return null;
  return { startMs: start, endMs: end };
}

// 本地时间文件名（原版用 toISOString 会差 8 小时）
function fileStamp() {
  const d = new Date();
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
         `_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

function isDark() {
  try {
    const w = (typeof unsafeWindow !== 'undefined' && unsafeWindow.matchMedia) ? unsafeWindow : window;
    return !!(w.matchMedia && w.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (e) { return false; }
}

function store(key, val) {
  try { if (typeof GM_setValue === 'function') GM_setValue(key, val); } catch (e) {}
}
function load(key, def) {
  try {
    if (typeof GM_getValue === 'function') {
      const v = GM_getValue(key, def);
      return v === undefined ? def : v;
    }
  } catch (e) {}
  return def;
}

/* ============================================================
 * 五、UI：面板 + Toast + 弹窗
 * ============================================================ */
function toast(msg, ms) {
  if (!appContext) return;
  let t = appContext.getElementById('sex-toast');
  if (!t) {
    t = appContext.createElement('div');
    t.id = 'sex-toast';
    appContext.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), ms || 2600);
}

function injectStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  (doc.head || doc.documentElement).appendChild(s);
}

function mkBtn(doc, label, cls, onClick) {
  const b = doc.createElement('button');
  b.className = 'sex-btn' + (cls ? ' ' + cls : '');
  b.textContent = label;
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

function buildPanel(doc) {
  const panel = doc.createElement('div');
  panel.id = PANEL_ID;
  if (isDark()) panel.classList.add('sex-dark');

  // 标题栏（拖拽把手 + 折叠）
  const header = doc.createElement('div');
  header.id = 'sex-header';
  const title = doc.createElement('span');
  title.textContent = '字幕导出';
  const toggle = doc.createElement('button');
  toggle.id = 'sex-toggle';
  toggle.type = 'button';
  toggle.title = '折叠 / 展开';
  toggle.textContent = opts.panelCollapsed ? '+' : '−';
  toggle.onclick = e => {
    e.stopPropagation();
    const body = panel.querySelector('#sex-body');
    const collapsed = body.style.display === 'none';
    body.style.display = collapsed ? 'block' : 'none';
    toggle.textContent = collapsed ? '−' : '+';
    opts.panelCollapsed = !collapsed;
    saveOpts();
  };
  header.appendChild(title);
  header.appendChild(toggle);

  const body = doc.createElement('div');
  body.id = 'sex-body';

  // ① 读取字幕 → 停止读取字幕 → 重新读取字幕（三态合一）
  ui.readButton = mkBtn(doc, '读取字幕', '', onReadClick);

  // ② 导出 SRT  ③ 导出 TXT
  ui.srtButton = mkBtn(doc, '导出 SRT', '', () => doExport('srt'));
  ui.srtButton.disabled = true;
  ui.txtButton = mkBtn(doc, '导出 TXT', 'alt', () => doExport('txt'));
  ui.txtButton.disabled = true;

  // ④ 更多格式（VTT / Markdown / JSON / CSV 收纳在下拉里）
  ui.select = doc.createElement('select');
  ui.select.id = 'sex-select';
  ui.select.title = '更多导出格式';
  const ph = doc.createElement('option');
  ph.value = ''; ph.textContent = '更多格式…';
  ui.select.appendChild(ph);
  [['vtt', '导出 VTT'], ['md', '导出 Markdown'], ['json', '导出 JSON'], ['csv', '导出 CSV']]
    .forEach(([v, t]) => {
      const o = doc.createElement('option');
      o.value = v; o.textContent = t;
      ui.select.appendChild(o);
    });
  ui.select.disabled = true;
  ui.select.onchange = () => {
    const v = ui.select.value;
    ui.select.value = '';
    if (v) doExport(v);
  };

  // ⑤ 预览  ⑥ 复制到剪贴板
  ui.previewButton = mkBtn(doc, '预览', 'ghost', showPreview);
  ui.previewButton.disabled = true;
  ui.copyButton = mkBtn(doc, '复制到剪贴板', 'ghost', copyToClipboard);
  ui.copyButton.disabled = true;

  // ⑦ 设置
  ui.settingsButton = mkBtn(doc, '设置', '', showSettings);

  // 状态 & 进度
  ui.status = doc.createElement('div');
  ui.status.id = 'sex-status';
  ui.status.textContent = '点击「读取字幕」开始';

  ui.progress = doc.createElement('div');
  ui.progress.id = 'sex-progress';
  const bar = doc.createElement('div');
  bar.id = 'sex-bar';
  ui.fill = doc.createElement('div');
  ui.fill.id = 'sex-fill';
  bar.appendChild(ui.fill);
  ui.ptext = doc.createElement('div');
  ui.ptext.id = 'sex-text';
  ui.progress.appendChild(bar);
  ui.progress.appendChild(ui.ptext);

  body.appendChild(ui.readButton);
  body.appendChild(ui.srtButton);
  body.appendChild(ui.txtButton);
  body.appendChild(ui.select);
  body.appendChild(ui.previewButton);
  body.appendChild(ui.copyButton);
  body.appendChild(ui.settingsButton);
  body.appendChild(ui.progress);
  body.appendChild(ui.status);

  panel.appendChild(header);
  panel.appendChild(body);
  doc.body.appendChild(panel);

  if (opts.panelCollapsed) body.style.display = 'none';

  makeDraggable(doc, panel, header);
  restorePosition(panel);
  ui.panel = panel;
}

function makeDraggable(doc, panel, handle) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  const onMove = e => {
    if (!dragging) return;
    const x = ox + e.clientX - sx;
    const y = oy + e.clientY - sy;
    setPosition(panel, x, y);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    doc.removeEventListener('mousemove', onMove, true);
    doc.removeEventListener('mouseup', onUp, true);
    opts.panelPos = { x: parseFloat(panel.style.left) || 0, y: parseFloat(panel.style.top) || 0 };
    saveOpts();
  };
  handle.addEventListener('mousedown', e => {
    if (e.target.id === 'sex-toggle') return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    ox = parseFloat(panel.style.left) || panel.offsetLeft;
    oy = parseFloat(panel.style.top) || panel.offsetTop;
    panel.style.right = 'auto';
    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('mouseup', onUp, true);
    e.preventDefault();
  });
}

function setPosition(panel, x, y) {
  const vw = (appContext && appContext.defaultView ? appContext.defaultView : window).innerWidth || 1280;
  const vh = (appContext && appContext.defaultView ? appContext.defaultView : window).innerHeight || 720;
  x = Math.max(0, Math.min(x, vw - panel.offsetWidth - 4));
  y = Math.max(0, Math.min(y, vh - 60));
  panel.style.left = x + 'px';
  panel.style.top = y + 'px';
}

function restorePosition(panel) {
  const vw = (appContext && appContext.defaultView ? appContext.defaultView : window).innerWidth || 1280;
  const saved = opts.panelPos;
  if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
    setPosition(panel, saved.x, saved.y);
  } else {
    setPosition(panel, vw - panel.offsetWidth - 20, 120);
  }
}

function setExportEnabled(on) {
  ui.srtButton.disabled = !on;
  ui.txtButton.disabled = !on;
  ui.select.disabled = !on;
  ui.previewButton.disabled = !on;
  ui.copyButton.disabled = !on;
}

function updateStatus() {
  if (!subtitles.length) {
    ui.status.textContent = '暂无数据';
    return;
  }
  let maxEnd = 0, first = Infinity;
  for (const it of subtitles) {
    const t = parseTimeOffset(it.timeOffset);
    if (!t) continue;
    if (t.startMs < first) first = t.startMs;
    if (t.endMs > maxEnd) maxEnd = t.endMs;
  }
  const span = Number.isFinite(first) ? fmtClock(maxEnd - first) : fmtClock(maxEnd);
  ui.status.textContent = `共 ${subtitles.length} 条 · 时长 ${span}`;
}

/* ------------------------------------------------------------
 * 弹窗：预览 / 设置
 * ------------------------------------------------------------ */
function modal(titleText) {
  const wrap = appContext.createElement('div');
  wrap.id = 'sex-modal';
  const inner = appContext.createElement('div');
  inner.id = 'sex-modal-inner';
  if (isDark()) inner.classList.add('sex-dark');
  const h = appContext.createElement('h3');
  h.textContent = titleText;
  inner.appendChild(h);
  wrap.appendChild(inner);
  wrap.addEventListener('click', e => {
    if (e.target === wrap && appContext.body.contains(wrap)) appContext.body.removeChild(wrap);
  });
  appContext.body.appendChild(wrap);
  return { wrap, inner, close: () => { if (appContext.body.contains(wrap)) appContext.body.removeChild(wrap); } };
}

function showPreview() {
  if (!subtitles.length) { toast('请先读取字幕'); return; }
  const text = buildTxt(normalize());
  const lines = text.split(/\r?\n/);
  const shown = lines.slice(0, CONFIG.previewMaxLines).join('\n');
  const { wrap, inner, close } = modal(`预览（共 ${subtitles.length} 条，按 TXT 格式显示前 ${Math.min(lines.length, CONFIG.previewMaxLines)} 行）`);
  const pre = appContext.createElement('pre');
  pre.textContent = shown || '（无内容）';
  const btn = mkBtn(appContext, '关闭', '', close);
  inner.appendChild(pre);
  inner.appendChild(btn);
}

function showSettings() {
  const boxes = [];
  const mk = (key, label) => {
    const l = appContext.createElement('label');
    const c = appContext.createElement('input');
    c.type = 'checkbox';
    c.checked = !!opts[key];
    c.onchange = () => { opts[key] = c.checked; saveOpts(); };
    const s = appContext.createElement('span');
    s.textContent = label;
    l.appendChild(c);
    l.appendChild(s);
    inner.appendChild(l);
    boxes.push([key, c]);
  };

  const { inner, close } = modal('设置');
  mk('txtMergeParagraph', 'TXT/MD 按段落合并（关闭则一句一行）');
  mk('txtWithTime', 'TXT 每行前加时间戳');
  mk('includeSpeaker', '提取说话人');
  mk('useGMDownload', '使用 GM_download（大文件更省内存）');

  const tip = appContext.createElement('div');
  tip.id = 'sex-tip';
  tip.textContent = '提示：若页面改版导致读取失败，请修改脚本顶部 CONFIG 中的 containerSelectors / wordSelectors。说话人与时间戳为可选增强，取不到时自动留空。';
  inner.appendChild(tip);

  // 已保存过的偏好会覆盖默认值，提供一键回滚（只重置开关，面板位置与折叠态保留）
  const reset = mkBtn(appContext, '恢复默认设置', 'ghost', () => {
    resetOptions();
    boxes.forEach(([key, c]) => { c.checked = !!opts[key]; });
    toast('已恢复默认设置（全部不勾选）');
  });
  inner.appendChild(reset);
  inner.appendChild(mkBtn(appContext, '关闭', '', close));
}

function resetOptions() {
  OPT_KEYS.forEach(k => { opts[k] = DEFAULTS[k]; });
  saveOpts();
}

/* ============================================================
 * 六、读取：增量收集 + 自适应滚动
 * ============================================================ */
function onReadClick() {
  if (reading) { stopRequested = true; return; }
  startReading();
}

// 容器可能被 SPA 重建，读取前确保它还在
function ensureContainer() {
  if (container && appContext && appContext.contains(container)) return true;
  if (appContext) {
    for (const sel of CONFIG.containerSelectors) {
      const el = appContext.querySelector(sel);
      if (el) { container = el; return true; }
    }
  }
  const found = findContainerDoc();
  if (found) {
    appContext = found.doc;
    container = found.doc.querySelector(found.sel);
    injectStyle(found.doc);
    return !!container;
  }
  return false;
}

function startReading() {
  if (!ensureContainer()) { toast('未找到字幕容器，请刷新页面'); return; }

  gen++;
  const myGen = gen;
  clearTimeout(timerId);

  reading = true;
  stopRequested = false;
  subtitles = [];
  seenParagraphs = new WeakSet();

  setExportEnabled(false);
  ui.readButton.textContent = '停止读取字幕';
  ui.readButton.classList.remove('alt');
  ui.readButton.classList.add('danger');
  ui.progress.style.display = 'block';
  ui.fill.style.width = '0%';
  ui.ptext.textContent = '0% · 0 条';
  ui.status.textContent = '读取中…';

  // 防回滚守卫：只在脚本自己滚动期间生效
  let maxScrollTop = 0;
  const guard = () => {
    if (!CONFIG.blockUpwardScroll || !reading || myGen !== gen) return;
    if (container.scrollTop > maxScrollTop) maxScrollTop = container.scrollTop;
    else if (container.scrollTop < maxScrollTop - 1) container.scrollTop = maxScrollTop;
  };
  container.addEventListener('scroll', guard, { passive: true });

  const startedAt = Date.now();
  let bottomIdle = 0;
  let lastCount = 0;
  let lastHeight = 0;
  let lastPct = -1;

  const cleanup = () => {
    reading = false;
    container.removeEventListener('scroll', guard);
    ui.readButton.textContent = '重新读取字幕';
    ui.readButton.classList.remove('danger');
    ui.progress.style.display = 'none';
  };

  const finalize = () => {
    clearTimeout(timerId);
    // DOM 顺序通常就是 pid/sid 升序；只在真的乱序时才排序（O(n) 检查代替无条件 O(n log n)）
    let ordered = true;
    for (let i = 1; i < subtitles.length; i++) {
      const a = subtitles[i - 1], b = subtitles[i];
      if (b.pid < a.pid || (b.pid === a.pid && b.sid < a.sid)) { ordered = false; break; }
    }
    if (!ordered) {
      subtitles.sort((a, b) => a.pid - b.pid || a.sid - b.sid);
      log('检测到乱序，已排序');
    }
    cleanup();
    if (!subtitles.length) {
      toast('未读到字幕内容，可能是页面结构已变更');
      ui.status.textContent = '读取失败';
      return;
    }
    setExportEnabled(true);
    updateStatus();
    toast(`读取完成：${subtitles.length} 条`, 2000);
    log('读取完成', subtitles.length);
  };

  const step = () => {
    if (myGen !== gen) return;                       // 旧回调直接作废
    if (stopRequested) { finalize(); return; }
    if (Date.now() - startedAt > CONFIG.maxTotalTime) {
      toast('读取超时，已导出已读到的部分');
      finalize();
      return;
    }

    const before = subtitles.length;
    collectOnce();
    const grew = subtitles.length > before || container.scrollHeight > lastHeight;
    lastHeight = container.scrollHeight;

    const vh = container.clientHeight;
    const atBottom = container.scrollTop + vh + 5 >= container.scrollHeight;

    // 进度条节流：变化不足 1% 不触发重排
    const pct = Math.min(((container.scrollTop + vh) / container.scrollHeight) * 100, 100);
    if (Math.abs(pct - lastPct) >= 1 || subtitles.length !== lastCount) {
      ui.fill.style.width = pct.toFixed(1) + '%';
      ui.ptext.textContent = `${pct.toFixed(0)}% · ${subtitles.length} 条`;
      lastPct = pct; lastCount = subtitles.length;
    }

    if (atBottom) {
      if (subtitles.length > before) { bottomIdle = 0; timerId = setTimeout(step, CONFIG.minDelay); }
      else if (++bottomIdle >= CONFIG.bottomIdleRounds) { finalize(); }
      else { timerId = setTimeout(step, CONFIG.idleDelay); }
      return;
    }

    // 不可滚动（内容全部已加载）：扫一遍即可收工
    if (container.scrollHeight <= vh + 5) { finalize(); return; }

    container.scrollTop += Math.max(160, Math.floor(vh * CONFIG.scrollStepRatio));
    timerId = setTimeout(step, grew ? CONFIG.minDelay : CONFIG.idleDelay);
  };

  container.scrollTop = 0;
  lastHeight = container.scrollHeight;
  timerId = setTimeout(step, 350);
}

// 增量收集：已处理过的段落用 WeakSet 直接跳过，避免每轮全树重扫
function collectOnce() {
  const paras = container.querySelectorAll('[' + CONFIG.pidAttr + ']');
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    if (seenParagraphs.has(p)) continue;
    seenParagraphs.add(p);
    const pid = parseInt(p.getAttribute(CONFIG.pidAttr), 10);
    if (!Number.isFinite(pid)) continue;
    const speaker = extractSpeaker(p);

    const sents = p.querySelectorAll('[' + CONFIG.sidAttr + ']');
    for (let j = 0; j < sents.length; j++) {
      const s = sents[j];
      const sid = parseInt(s.getAttribute(CONFIG.sidAttr), 10);
      const timeOffset = s.getAttribute(CONFIG.timeAttr);
      if (!Number.isFinite(sid) || !timeOffset) continue;
      const text = extractText(s);
      if (!text) continue;
      subtitles.push({ pid, sid, speaker, text, timeOffset });
    }
  }
}

// 缓存命中过词节点的选择器，后续只跑最快的那一个
function extractText(sentence) {
  let nodes = null;
  if (activeWordSelector) {
    const n = sentence.querySelectorAll(activeWordSelector);
    if (n.length) nodes = n;
  }
  if (!nodes) {
    for (const sel of CONFIG.wordSelectors) {
      const n = sentence.querySelectorAll(sel);
      if (n.length) { activeWordSelector = sel; nodes = n; break; }
    }
  }
  if (!nodes || !nodes.length) {
    return (sentence.textContent || '').replace(/\s+/g, ' ').trim();
  }
  let t = '';
  for (let i = 0; i < nodes.length; i++) t += nodes[i].textContent;
  return t.replace(/\s+/g, ' ').trim();
}

function extractSpeaker(paragraph) {
  if (!opts.includeSpeaker) return '';
  if (activeSpeakerSelector) {
    const el = paragraph.querySelector(activeSpeakerSelector);
    if (el) {
      const t = (el.textContent || '').trim();
      if (t) return cleanSpeaker(t);
    }
  }
  for (const sel of CONFIG.speakerSelectors) {
    const el = paragraph.querySelector(sel);
    if (!el) continue;
    const t = (el.textContent || '').trim();
    if (t) { activeSpeakerSelector = sel; return cleanSpeaker(t); }
  }
  return '';
}
const cleanSpeaker = s => s.replace(/[：:]\s*$/, '').slice(0, 40);

/* ============================================================
 * 七、导出：多种格式
 * ============================================================ */
function normalize() {
  const out = [];
  for (const it of subtitles) {
    const t = parseTimeOffset(it.timeOffset);
    out.push({
      pid: it.pid, sid: it.sid, speaker: it.speaker, text: it.text,
      startMs: t ? t.startMs : null, endMs: t ? t.endMs : null
    });
  }
  return out;
}

function buildSrt(items) {
  const buf = [];
  let seq = 1;
  for (const it of items) {
    if (it.startMs === null) continue;
    const line = (CONFIG.srtWithSpeaker && it.speaker) ? `${it.speaker}：${it.text}` : it.text;
    buf.push(seq++, '\r\n', fmtSRT(it.startMs), ' --> ', fmtSRT(it.endMs), '\r\n', line, '\r\n\r\n');
  }
  return buf.join('');
}

function buildVtt(items) {
  const buf = ['WEBVTT\r\n\r\n'];
  for (const it of items) {
    if (it.startMs === null) continue;
    buf.push(fmtVTT(it.startMs), ' --> ', fmtVTT(it.endMs), '\r\n', it.text, '\r\n\r\n');
  }
  return buf.join('');
}

// 按 pid 聚合成段落，供 TXT / Markdown 复用
function groupByParagraph(items) {
  const groups = new Map();
  for (const it of items) {
    let g = groups.get(it.pid);
    if (!g) {
      g = { pid: it.pid, speaker: it.speaker, startMs: it.startMs, texts: [] };
      groups.set(it.pid, g);
    }
    if (!g.speaker && it.speaker) g.speaker = it.speaker;
    if (g.startMs === null && it.startMs !== null) g.startMs = it.startMs;
    g.texts.push(it.text);
  }
  return Array.from(groups.values());
}

// 说话人输出统一受「提取说话人」开关约束：开关关闭时即便旧数据里残留名字也不输出
const whoPrefix = s => (opts.includeSpeaker && s ? `${s}：` : '');
const timePrefix = ms => (ms === null ? '' : `[${fmtClock(ms)}] `);

// TXT：默认一句一行，可在「设置」中切换为按段落合并 / 加时间戳
function buildTxt(items) {
  const buf = [];
  if (opts.txtMergeParagraph) {
    for (const g of groupByParagraph(items)) {
      buf.push((opts.txtWithTime ? timePrefix(g.startMs) : '') + whoPrefix(g.speaker) + g.texts.join(''), '\r\n\r\n');
    }
  } else {
    for (const it of items) {
      buf.push((opts.txtWithTime ? timePrefix(it.startMs) : '') + whoPrefix(it.speaker) + it.text, '\r\n');
    }
  }
  return buf.join('');
}

function buildMarkdown(items) {
  const buf = ['# 会议字幕\r\n\r\n'];
  if (opts.txtMergeParagraph) {
    for (const g of groupByParagraph(items)) {
      const t = g.startMs === null ? '' : ` · ${fmtClock(g.startMs)}`;
      if (opts.includeSpeaker) buf.push(`### ${g.speaker || '未标注'}${t}\r\n\r\n`);
      buf.push(g.texts.join(''), '\r\n\r\n');
    }
  } else {
    let lastPid = null;
    for (const it of items) {
      const t = it.startMs === null ? '' : `[${fmtClock(it.startMs)}] `;
      if (it.pid !== lastPid) {
        buf.push('\r\n');
        if (opts.includeSpeaker && it.speaker) buf.push(`**${it.speaker}** `);
        lastPid = it.pid;
      }
      buf.push(t, it.text, '  \r\n');
    }
  }
  return buf.join('');
}

function buildJson(items) {
  const arr = items.map((it, i) => ({
    index: i + 1,
    pid: it.pid,
    sid: it.sid,
    startMs: it.startMs,
    endMs: it.endMs,
    start: it.startMs === null ? null : fmtSRT(it.startMs),
    end: it.endMs === null ? null : fmtSRT(it.endMs),
    speaker: it.speaker || null,
    text: it.text
  }));
  return JSON.stringify({ exportedAt: new Date().toISOString(), count: arr.length, subtitles: arr }, null, 2);
}

const csvCell = v => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
function buildCsv(items) {
  const buf = ['序号,开始,结束,开始(ms),结束(ms),说话人,文本\r\n'];
  items.forEach((it, i) => {
    buf.push(
      i + 1, ',',
      csvCell(it.startMs === null ? '' : fmtSRT(it.startMs)), ',',
      csvCell(it.endMs === null ? '' : fmtSRT(it.endMs)), ',',
      csvCell(it.startMs), ',', csvCell(it.endMs), ',',
      csvCell(it.speaker), ',', csvCell(it.text), '\r\n'
    );
  });
  return buf.join('');
}

const BUILDERS = { srt: buildSrt, vtt: buildVtt, txt: buildTxt, md: buildMarkdown, json: buildJson, csv: buildCsv };
const MIME = {
  srt: 'text/plain;charset=utf-8', vtt: 'text/vtt;charset=utf-8',
  txt: 'text/plain;charset=utf-8', md: 'text/markdown;charset=utf-8',
  json: 'application/json;charset=utf-8', csv: 'text/csv;charset=utf-8'
};
// 只在 Excel 友好格式上加 BOM；SRT/VTT/JSON 加 BOM 反而会被解析器读错
const NEED_BOM = { txt: true, csv: true };

function doExport(format) {
  if (!subtitles.length) { toast('请先读取字幕'); return; }
  const build = BUILDERS[format];
  if (!build) return;
  const items = normalize();
  const content = build(items);
  if (!content || !content.trim()) { toast('未能生成内容，请检查字幕数据'); return; }
  const name = `腾讯会议字幕_${fileStamp()}.${format}`;
  saveFile(name, (NEED_BOM[format] ? '\uFEFF' : '') + content, MIME[format]);
  toast(`已导出 ${format.toUpperCase()}：${name}`, 3000);
}

function saveFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  if (opts.useGMDownload && typeof GM_download === 'function') {
    try {
      const url = URL.createObjectURL(blob);
      GM_download({ url, name, saveAs: false });
      setTimeout(() => URL.revokeObjectURL(url), 60000);   // 延迟回收，避免打断下载
      return;
    } catch (e) { log('GM_download 失败，回落 anchor', e); }
  }
  const url = URL.createObjectURL(blob);
  const a = appContext.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  appContext.body.appendChild(a);
  a.click();
  appContext.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function copyToClipboard() {
  if (!subtitles.length) { toast('请先读取字幕'); return; }
  const text = buildTxt(normalize());
  const done = () => toast('已复制到剪贴板', 2000);
  try {
    const w = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
    if (w.navigator && w.navigator.clipboard && w.navigator.clipboard.writeText) {
      w.navigator.clipboard.writeText(text).then(done, fallback);
      return;
    }
  } catch (e) {}
  fallback();
  function fallback() {
    try {
      const ta = appContext.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      appContext.body.appendChild(ta);
      ta.select();
      appContext.execCommand('copy');
      appContext.body.removeChild(ta);
      done();
    } catch (e) { toast('复制失败，请改用导出文件'); }
  }
}

/* ============================================================
 * 八、注入检测：防抖 + 跨域 iframe 缓存 + 重试上限
 * ============================================================ */
const badIframes = new WeakSet();     // 记住跨域 iframe，之后直接跳过，省掉异常开销

function findContainerDoc() {
  for (const sel of CONFIG.containerSelectors) {
    try { if (document.querySelector(sel)) return { doc: document, sel }; }
    catch (e) {}
  }
  const frames = document.querySelectorAll('iframe');
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (badIframes.has(f)) continue;
    let d = null;
    try { d = f.contentDocument || (f.contentWindow && f.contentWindow.document); }
    catch (e) { badIframes.add(f); continue; }   // 跨域：记黑名单，不再重试
    if (!d) continue;
    for (const sel of CONFIG.containerSelectors) {
      try { if (d.querySelector(sel)) return { doc: d, sel }; } catch (e) {}
    }
  }
  return null;
}

let detectTimer = null;
let detectTries = 0;

function tryInject() {
  if (uiInjected) return;
  const found = findContainerDoc();
  if (!found) {
    if (++detectTries >= CONFIG.detectMaxTries) {
      observer.disconnect();
      log('未找到字幕容器，已停止检测');
    }
    return;
  }
  uiInjected = true;
  observer.disconnect();
  appContext = found.doc;
  container = found.doc.querySelector(found.sel);
  injectStyle(found.doc);
  buildPanel(found.doc);
  log('面板已注入，容器选择器：', found.sel);

  // SPA 重建后重新注入（低频检查，开销可忽略）
  setInterval(() => {
    if (ui.panel && !found.doc.contains(ui.panel)) {
      log('面板丢失，重新注入');
      cancelReading();
      uiInjected = false;
      detectTries = 0;
      observer.observe(document.body, { childList: true, subtree: true });
      tryInject();
    }
  }, 2000);
}

function cancelReading() {
  gen++;
  clearTimeout(timerId);
  reading = false;
  stopRequested = false;
}

// 防抖：避免页面每次 DOM 变动都跑一遍查找
const observer = new MutationObserver(() => {
  clearTimeout(detectTimer);
  detectTimer = setTimeout(tryInject, CONFIG.detectDebounce);
});
observer.observe(document.body, { childList: true, subtree: true });
tryInject();

/* ============================================================
 * 九、脚本菜单
 * ============================================================ */
if (typeof GM_registerMenuCommand === 'function') {
  GM_registerMenuCommand('打开导出设置', () => {
    if (!appContext) return;
    showSettings();
  });
  GM_registerMenuCommand('恢复默认导出设置', () => {
    resetOptions();
    toast('已恢复默认设置（全部不勾选）');
  });
  GM_registerMenuCommand('重置字幕导出面板位置', () => {
    opts.panelPos = null;
    saveOpts();
    if (ui.panel) {
      const vw = (appContext && appContext.defaultView ? appContext.defaultView : window).innerWidth || 1280;
      setPosition(ui.panel, vw - ui.panel.offsetWidth - 20, 120);
    }
    toast('已重置面板位置');
  });
}

})();
