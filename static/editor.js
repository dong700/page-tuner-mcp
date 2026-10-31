const $ = (id) => document.getElementById(id);

// 绑定事件时容忍元素不存在：这套工具允许你编辑「编辑器自己」的界面，
// 界面上的按钮随时可能被你删掉，少一个按钮不能把整个编辑器启动流程弄崩
function on(id, type, fn) {
  const el = $(id);
  if (el) el.addEventListener(type, fn);
  return el;
}
const BUILD = "p14";             // 显示在顶栏，用来确认没被浏览器缓存成旧版本

// 这个页面正在被别人「当素材」预览（比如用精修器改精修器自己的界面）：
// 既不能再启动一套编辑器，也不能让它里面的 <iframe> 递归加载自己
const IS_PREVIEW = (() => {
  try { return window.self !== window.top; } catch (_) { return true; }
})();
if (IS_PREVIEW) {
  // 别删这个 iframe：保存是把预览的 DOM 序列化写回去的，删掉就再也回不来了。
  // 只把它指到 about:blank 停掉递归，并记住原来的 src，wholeHtml() 会在保存/导出时还原。
  const inner = document.getElementById("frame");
  if (inner) {
    inner.setAttribute("data-ct-iframe", inner.getAttribute("src") || "/preview");
    inner.setAttribute("src", "about:blank");
  }
}

// 几何类（走 inline）：跟状态无关，改一次定型
const GEO_FIELDS = [
  "fText", "fFontSize", "fFontWeight", "fLineHeight", "fTextAlign",
  "fPadding", "fMargin", "fWidth", "fLeft", "fTop",
];
// 视觉类（走 .pt-N 类名 + <style> 块）：可以分别给「基础」「悬停」两态各写一套
const VISUAL_FIELDS = ["fColor", "fBackground", "fRadius", "fOpacity", "fGradAngle", "fGradFrom", "fGradTo"];

let frame = null;
let ct = null;                   // iframe 内的编辑接口
let current = null;              // 当前选中元素的信息
let stateMode = "base";          // 面板正在改哪一态：base / hover / active
let browseMode = false;          // 浏览模式：点击就是真实操作，不选中元素
let dragMode = "reorder";        // 拖动语义：换顺序 / 挪位置
let undoStack = [];
let redoStack = [];
let pendingHtml = null;          // 控件获得焦点时的快照，第一次 input 才入栈
let region = null;               // 圈选区域快照（给 agent 的那份）
let regionMode = false;
let regionIntent = "";           // 这次交给 agent 的意图：style / text / add / all
let fileMtime = 0;               // 页面文件最后修改时间，用来发现 agent 落了盘
let reloading = false;           // iframe 正在为同步外部改动而重载
let pendingSnap = null;          // 重载前拍的快照，重载完用来恢复滚动/选中/选区
let lastSavedHtml = null;        // 上次保存时 iframe 里的内容，用来判断本地有没有没存的改动

const INTENT = { style: "改样式", text: "改文案", add: "加元素", all: "整块交给你" };
const INTENT_HINT = {
  style: "用 html_style 直接改上面的 id；改完调 html_clean。",
  text: "用 html_text 改上面的 id；改完调 html_clean。",
  add: "用 html_insert 在父级或第一个 id 的前/后/内部插入新元素；插完调 html_clean。",
  all: "按原话自行决定：改样式 html_style、改文案 html_text、换顺序 html_move、加元素 html_insert；改完调 html_clean。",
};

/* ---------------- 小工具 ---------------- */

function setStatus(text, bad) {
  const el = $("status");
  if (!el) return;                 // 状态条被你删了也不能让编辑器崩
  el.textContent = text;
  el.style.color = bad ? "#dc2626" : "#6b7280";
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function toHex(color) {
  if (!color || color === "none" || color === "transparent") return "#ffffff";
  if (color.startsWith("#")) return color.length === 4
    ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
    : color.slice(0, 7);
  const found = color.match(/rgba?\(([^)]+)\)/);
  if (!found) return "#ffffff";
  const nums = found[1].split(/[,/]/).map((v) => parseFloat(v.trim()));
  const [r, g, b, a] = nums;
  if (a === 0) return "#ffffff";
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function syncHistory() {
  const undo = $("undoBtn");
  const redo = $("redoBtn");
  if (undo) undo.disabled = undoStack.length === 0;
  if (redo) redo.disabled = redoStack.length === 0;
}

/* ---------------- 面板：取值 / 预设回显 ---------------- */

function rgbToHex(v) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v || "");
  if (!m) return "";
  const hex = (n) => (+n).toString(16).padStart(2, "0");
  return "#" + hex(m[1]) + hex(m[2]) + hex(m[3]);
}

// 从 computed 的 backgroundImage 里抠出渐变角度和两个端点色，面板据此回显
function gradInfo(img) {
  if (!img || !/gradient/i.test(img)) return null;
  const ang = /(-?\d+)deg/.exec(img);
  const hits = img.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/gi) || [];
  const hex = (v) => (v && v[0] === "#" ? v.slice(0, 7) : rgbToHex(v));
  return { angle: ang ? Number(ang[1]) : 135, from: hex(hits[0]), to: hex(hits[1]) };
}

function normCss(v) {
  return String(v || "").replace(/\s+/g, "").toLowerCase();
}

// 阴影/渐变这类"预设"要看当前元素到底是什么值，否则切元素后按钮亮着但和图对不上。
// 浏览器回读会补一个 0px 的 spread，所以比较时把 0 丢掉再按数值排序比对。
function shadowSig(v) {
  const nums = (String(v || "").match(/[\d.]+/g) || []).map((n) => Number(n)).filter((n) => n !== 0);
  return nums.map(String).sort().join(",");
}

function sameGrad(a, b) {
  return !!a && !!b && a.angle === b.angle &&
    normCss(a.from) === normCss(b.from) && normCss(a.to) === normCss(b.to);
}

// 悬停预设是根据 hover 规则里的特征值反推的，切元素后也要跟着亮/灭
function hoverKind(info) {
  const h = info && info.rules ? info.rules.hover : null;
  if (!h || !Object.keys(h).length) return "";
  if (/translateY\(-6px\)/.test(h.transform || "")) return "lift";
  if (/scale\(1\.04\)/.test(h.transform || "")) return "scale";
  if (/36px/.test(h["box-shadow"] || "")) return "glow";
  if (/brightness\(1\.07\)/.test(h.filter || "")) return "bright";
  return "";
}

function syncPresets(info) {
  const img = info && info.sheet ? info.sheet.backgroundImage : "";
  const g = gradInfo(img);
  const angle = $("fGradAngle");
  const from = $("fGradFrom");
  const to = $("fGradTo");
  if (angle) angle.value = g ? g.angle : 135;
  if (from) from.value = (g && g.from) || "#a8edea";
  if (to) to.value = (g && g.to) || "#fed6e3";

  const gradRow = $("gradRow");
  if (gradRow) {
    for (const b of gradRow.querySelectorAll("button")) {
      b.classList.toggle("on", sameGrad(g, gradInfo(b.dataset.grad)));
    }
  }

  const shadowRow = $("shadowRow");
  if (shadowRow) {
    const shadow = info && info.sheet ? info.sheet.shadow : "";
    const sig = shadowSig(shadow);
    for (const b of shadowRow.querySelectorAll("button")) {
      b.classList.toggle("on", shadowSig(b.dataset.shadow) === sig);
    }
  }

  const hoverRow = $("hoverRow");
  if (hoverRow) {
    const kind = hoverKind(info);
    for (const b of hoverRow.querySelectorAll("button")) {
      b.classList.toggle("on", !!kind && b.dataset.hover === kind);
    }
  }
}

function refreshPanel() {
  if (!current || !ct) return;
  renderPanel(ct.setState(current.id, stateMode));
}

// 状态回读：规则里写过就用规则值，没写过就沿用基础态的实际渲染值
function ruleVal(info, name, state) {
  const st = state || stateMode;
  const h = info && info.rules && info.rules[st];
  if (!h) return undefined;
  const want = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return h[k];
  return undefined;
}

/* ---------------- 面板 ---------------- */

function setDisabled(disabled) {
  const geoOff = disabled || stateMode !== "base";
  for (const id of VISUAL_FIELDS) $(id).disabled = disabled;
  for (const id of GEO_FIELDS) $(id).disabled = geoOff;
  for (const el of document.querySelectorAll("[data-nudge], #upBtn, #downBtn, #zeroOffset")) el.disabled = geoOff;
  for (const el of document.querySelectorAll("#gradRow button, #shadowRow button, #hoverRow button")) el.disabled = disabled;
  for (const el of document.querySelectorAll("#parentBtn, #resetBtn, #deleteBtn, #clearBg, #applyGrad, #clearGrad")) el.disabled = disabled;
}

function renderPath(info) {
  const box = $("elPath");
  if (!box) return;
  box.innerHTML = "";
  if (!info) return;
  const add = (label, id, up) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (up ? " up" : "");
    b.dataset.id = id;
    b.textContent = label;
    box.appendChild(b);
  };
  if (info.parent && info.parent.id) {
    add(`↑ ${info.parent.tag}${dot(info.parent.cls)}`, info.parent.id, true);
  }
  (info.kids || []).forEach((k) => {
    add(`↓ ${k.tag}${k.text ? "「" + k.text + "」" : ""}`, k.id, false);
  });
}

function renderPanel(info) {
  current = info;
  const clearRows = () => {
    for (const row of ["gradRow", "shadowRow", "hoverRow"]) {
      const el = $(row);
      if (!el) continue;
      for (const b of el.querySelectorAll("button")) b.classList.remove("on");
    }
  };
  if (!info) {
    setDisabled(true);
    setText("elInfo", "点页面里的标题、卡片、按钮…");
    renderPath(null);
    const gp = $("gotoPageBtn");
    if (gp) gp.hidden = true;
    clearRows();
    return;
  }
  setDisabled(false);
  renderPath(info);

  // 选中的是站内链接：面板上直接给一个「去这一页」的入口
  const page = info.link && info.link.page ? info.link.page : "";
  const gotoBtn = $("gotoPageBtn");
  if (gotoBtn) {
    gotoBtn.hidden = !page;
    if (page) gotoBtn.textContent = `去 ${page}`;
  }

  const cls = (info.cls || "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
  const short = (info.text || "").slice(0, 24);
  const hasRule = stateMode === "hover" ? info.hasHover : stateMode === "active" ? info.hasActive : false;
  const mark = stateMode !== "base" && hasRule
    ? ` · ${stateMode === "hover" ? "悬停" : "按下"}已设` : "";
  setText("elInfo", `${info.tag}${cls ? " · " + cls : ""}${short ? " · " + short : " · 容器"}${mark}`);

  const s = info.sheet;
  const marked = stateMode !== "base";

  let radius = s.radius;
  let pct = s.opacity;
  let color = s.color;
  let bg = s.background;
  if (marked) {
    const rv = ruleVal(info, "border-radius");
    if (rv) { const n = parseFloat(rv); if (isFinite(n)) radius = n; }
    const ov = ruleVal(info, "opacity");
    if (ov) { const n = parseFloat(ov); if (isFinite(n)) pct = Math.round(n * 100); }
    color = ruleVal(info, "color") || s.color;
    bg = ruleVal(info, "background") || ruleVal(info, "background-color") || s.background;
  }

  const setVal = (id, v) => { const el = $(id); if (el) el.value = v; };
  setVal("fText", info.text || "");
  setVal("fFontSize", Math.round(s.fontSize) || "");
  setVal("fFontWeight", /^\d+$/.test(s.fontWeight) ? s.fontWeight : "");
  setVal("fLineHeight", s.lineHeight ? Math.round(s.lineHeight) : "");
  setVal("fTextAlign", /^(left|center|right)$/.test(s.textAlign) ? s.textAlign : "");
  setVal("fColor", toHex(color));
  setVal("fBackground", toHex(bg));
  setVal("fRadius", Math.round(radius) || 0);
  setVal("fOpacity", Math.round(pct));
  const opacityVal = $("opacityVal");
  if (opacityVal) opacityVal.textContent = Math.round(pct);
  setVal("fPadding", Math.round(s.paddingTop) || 0);
  setVal("fMargin", Math.round(s.marginTop) || 0);
  setVal("fWidth", Math.round(s.width) || 0);
  setVal("fLeft", Math.round(s.left) || 0);
  setVal("fTop", Math.round(s.top) || 0);

  // 渐变/阴影这类预设跟着当前元素回显，避免切换元素后还留着上一个的值
  syncPresets(info);

  // 容器（有子元素、自己没有文字）改文字会把子层级整段吃掉，直接锁掉这个输入框
  const canEditText = !(info.hasChildren && !info.text);
  const textBox = $("fText");
  if (textBox) {
    textBox.disabled = !canEditText || marked;
    textBox.placeholder = canEditText ? "" : "容器含子元素，请点到子元素上改文字";
  }
}

function setStateMode(mode) {
  stateMode = mode === "hover" || mode === "active" ? mode : "base";
  for (const btn of document.querySelectorAll("#stateSeg [data-state]")) {
    btn.classList.toggle("on", btn.dataset.state === stateMode);
  }
  const HINT = {
    base: "正在改「基础」样式；切到「悬停」就是改鼠标移上去的效果（编辑时持续预演）",
    hover: "正在改「悬停」样式：只影响鼠标移上去时，编辑时页面已持续预演；字号、间距这类几何控件先锁住",
    active: "正在改「按下」样式：只影响鼠标按住时；要看真实效果，切到「浏览页面」按住按钮试",
  };
  setText("stateHint", HINT[stateMode]);
  if (!ct) { renderPanel(current); return; }
  const info = current ? ct.setState(current.id, stateMode) : ct.setState(null, stateMode);
  renderPanel(info);
}

window.__ctPick = function (info) {
  renderPanel(info);
  if (info) setStatus(`已选中 ${info.tag} · ${BUILD}`);
};

/* ---------------- 改动日志：把人动过的每一处交给 agent ----------------
 * 人改样式/文案/挪位置/删元素/整页排版，agent 都要知道。
 * 这里把每次操作记成一条结构化记录，防抖写到 <page>.changes.json，
 * MCP 的 html_changes 直接读同一份，不需要 agent 猜、也不需要比对整页文本。
 */

let journal = [];
let journalTimer = null;
const JOURNAL_LIMIT = 200;

function pageName() {
  const el = $("file");
  return el ? el.textContent.trim() : "";
}

function labelOf(info) {
  if (!info) return {};
  const cls = (info.cls || "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
  return { id: info.id, tag: info.tag, cls, text: (info.text || "").slice(0, 30) };
}

function updateChangeInfo() {
  const el = $("changeInfo");
  if (!el) return;
  el.hidden = !journal.length;
  el.textContent = journal.length ? `已记录 ${journal.length} 条改动（agent 可读）` : "";
}

function record(type, extra) {
  if (!ct) return;
  const now = Date.now();
  const info = labelOf(current);
  const last = journal[journal.length - 1];
  // 同一个元素、同一类操作、1 秒内的连续改动（拖滑块/连点方向键）合并成一条
  if (last && last.type === type && last.id === info.id &&
      (extra || {}).state === last.state && now - (last._ts || 0) < 900) {
    for (const key in extra || {}) {
      if (key === "props") {
        last.props = Object.assign({}, last.props || {}, extra.props || {});
      } else {
        last[key] = extra[key];
      }
    }
    last._ts = now;
  } else {
    journal.push(Object.assign({ type, at: new Date().toLocaleTimeString("zh-CN"),
                                 page: pageName(), _ts: now }, info, extra || {}));
    if (journal.length > JOURNAL_LIMIT) journal.shift();
  }
  updateChangeInfo();
  if (journalTimer) clearTimeout(journalTimer);
  journalTimer = setTimeout(flushJournal, 400);
}

async function flushJournal() {
  journalTimer = null;
  const entries = journal.map((it) => {
    const copy = {};
    for (const key in it) if (key !== "_ts") copy[key] = it[key];
    return copy;
  });
  try {
    await fetch("/api/changes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: pageName(), entries }),
    });
  } catch (_) {
    /* 本地工具，写不进去不影响继续编辑 */
  }
}

function pushJournal(reset) {
  if (reset) { journal = []; updateChangeInfo(); }
}

/* ---------------- 改动入口 ---------------- */

function pushUndo(html) {
  undoStack.push(html);
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  syncHistory();
}

// 视觉：写进当前状态的样式规则（基础 / 悬停）
function applyVisual(props) {
  if (!current || !ct) return;
  ct.apply(current.id, props, stateMode);
  record("style", { props, state: stateMode });
}

// 几何：仍旧走 inline
function applyGeo(props) {
  if (!current || !ct) return;
  ct.applyInline(current.id, props);
  record("geometry", { props });
}

// 位置微调：连续按键只记一条撤销，避免按住方向键把撤销栈刷爆
let lastNudgeAt = 0;

function nudge(dx, dy) {
  if (!current || !ct) return;
  const now = Date.now();
  if (now - lastNudgeAt > 500) pushUndo(ct.bodyHtml());
  lastNudgeAt = now;
  const o = ct.offset(current.id) || { left: 0, top: 0 };
  ct.setOffset(current.id, o.left + dx, o.top + dy);
  ct.select(current.id);
  record("move", { dx, dy });
  setStatus(`已挪动 ${dx > 0 ? "+" : ""}${dx} / ${dy > 0 ? "+" : ""}${dy} px`);
}

function setDragMode(mode) {
  dragMode = mode === "offset" ? "offset" : "reorder";
  for (const btn of document.querySelectorAll("#dragMode [data-mode]")) {
    btn.classList.toggle("on", btn.dataset.mode === dragMode);
  }
  if (ct) ct.setMode(dragMode);
  setText("modeHint", dragMode === "offset"
    ? "拖动就是跟手挪位置，其他元素完全不动；方向键可精确微调"
    : "在容器里拖会换顺序，其他元素自动让位；要挪位置就切「拖动·挪位置」");
  setStatus(dragMode === "offset" ? "拖动 = 挪位置" : "拖动 = 换顺序");
}

function bindField(id, handler) {
  const el = $(id);
  if (!el) return;   // 界面上删掉某个控件时，不要因此把绑定流程弄崩
  el.addEventListener("focusin", () => { if (ct) pendingHtml = ct.bodyHtml(); });
  el.addEventListener("blur", () => { pendingHtml = null; });
  el.addEventListener("input", () => {
    if (!current || !ct) return;
    if (pendingHtml !== null) { pushUndo(pendingHtml); pendingHtml = null; }
    handler(el);
  });
}

function reselect() {
  if (!current) return;
  const info = ct.select(current.id);
  if (!info) renderPanel(null);
}

/* ---------------- 悬停预设 ----------------
 * 一次落两条规则：基础态给 transition（让变化有过渡），悬停态给效果本体。
 * 落完自动切到「悬停」态，页面立刻预演，不用真的把鼠标移上去试。
 */

const HOVER_LABEL = { lift: "上浮", scale: "放大", glow: "发光", bright: "变亮", none: "已清除" };

function hoverPreset(kind) {
  if (!current || !ct) return;
  const id = current.id;
  pushUndo(ct.bodyHtml());
  if (kind === "lift") {
    ct.apply(id, { transition: "transform .2s ease, box-shadow .2s ease" }, "base");
    ct.apply(id, { transform: "translateY(-6px)", boxShadow: "0 18px 40px rgba(15,23,42,.18)" }, "hover");
  } else if (kind === "scale") {
    ct.apply(id, { transition: "transform .2s ease" }, "base");
    ct.apply(id, { transform: "scale(1.04)" }, "hover");
  } else if (kind === "glow") {
    ct.apply(id, { transition: "box-shadow .2s ease" }, "base");
    ct.apply(id, { boxShadow: "0 0 36px rgba(99,102,241,.5)" }, "hover");
  } else if (kind === "bright") {
    ct.apply(id, { transition: "filter .2s ease" }, "base");
    ct.apply(id, { filter: "brightness(1.07)" }, "hover");
  } else if (kind === "none") {
    ct.apply(id, { transition: "" }, "base");
    ct.apply(id, { transform: "", boxShadow: "", filter: "" }, "hover");
  } else {
    return;
  }
  setStateMode("hover");
  setStatus(`悬停效果：${HOVER_LABEL[kind]}`);
}

/* ---------------- 浏览模式 / 点击捕获 ----------------
 * 页面里的「点了之后变成什么样」写在 JS 里（文案 / 类名 / 定时器回弹），CSS 表达不了。
 * 浏览模式让人像用真页面一样点；捕获则把点击前后的差异抓下来，
 * 能改的部分（悬停/按下样式）在面板里改，写死在 JS 的交给 agent 改源码。
 */

function setBrowse(on) {
  browseMode = !!on;
  const btn = $("browseBtn");
  if (btn) {
    btn.textContent = browseMode ? "退出浏览" : "浏览页面";
    btn.classList.toggle("primary", browseMode);
  }
  if (ct) ct.setBrowse(browseMode);
  setStatus(browseMode ? "浏览模式：点击就是真实操作；要改样式点「退出浏览」" : "回到编辑模式");
}

function startCapture() {
  if (!ct) return;
  setBrowse(true);
  const btn = $("captureBtn");
  if (btn) btn.disabled = true;
  setText("captureInfo", "已就绪：去点页面里那个按钮，我记录它点完变成什么样…");
  ct.capture();
  setStatus("捕获中：去点要观察的元素");
}

function captureSummary(info) {
  const before = (info && info.before) || {};
  const after = (info && info.after) || {};
  if (!info || info.ms < 0 || (!after.text && !after.style && !after.cls)) return "";
  if (after.text === before.text && after.style === before.style && after.cls === before.cls) return "";
  const parts = [];
  if (after.text !== before.text) parts.push(`文字「${before.text}」→「${after.text}」`);
  if (after.style !== before.style) parts.push("inline 样式变了");
  if (after.cls !== before.cls) parts.push("类名变了");
  const tail = info.reverted ? `约 ${info.revertMs}ms 后自动变回去` : "点完一直保持";
  return `${info.id} 点击后 ${info.ms}ms：${parts.join("；")}，${tail}`;
}

window.__ctCaptured = function (info) {
  const btn = $("captureBtn");
  if (btn) btn.disabled = false;
  const summary = captureSummary(info);
  if (!summary) {
    setText("captureInfo", "点了没抓到变化（这个元素可能本来就不响应点击）");
    setStatus("没抓到变化");
    return;
  }
  setText("captureInfo", summary);
  setStatus(summary);
};

/* ---------------- 圈选：给 agent 的定位信息 ----------------
 * 人拖个框，这里把框里的元素压成一段紧凑文字：id + 标签 + 类名 + 文字 + 关键样式。
 * agent 读到就知道该改哪几个元素，不需要截图、也不需要额外的视觉模型。
 */

function dot(cls) {
  return cls ? "." + cls.replace(/\s+/g, ".") : "";
}

function regionText() {
  if (!region || !region.count) return "";
  const fileEl = $("file");
  const file = fileEl ? fileEl.textContent.trim() : "";
  const noteEl = $("regionNote");
  const note = noteEl ? noteEl.value.trim() : "";
  const p = region.parent;
  const lines = [];
  lines.push(`【页面精修 · 圈选】${file || ""} · ${new Date().toLocaleString("zh-CN")}`);
  if (regionIntent) lines.push(`要你做：${INTENT[regionIntent]}`);
  if (note) lines.push(`用户希望：${note}`);
  const where = p
    ? `，父级 ${p.id} ${p.tag}${dot(p.cls)}（display:${p.style.display}${p.style.gap ? " gap:" + p.style.gap : ""}）`
    : "";
  lines.push(`选区：${region.count} 个元素${where}`);
  region.items.forEach((it, i) => {
    const text = it.text ? `「${it.text}」` : "";
    const bg = it.style.background === "rgba(0, 0, 0, 0)" ? "透明" : it.style.background;
    lines.push(`${i + 1}. ${it.id} ${it.tag}${dot(it.cls)}${text} ` +
      `${it.size[0]}×${it.size[1]} · 字号${it.style.fontSize} 色${it.style.color} ` +
      `底${bg} 圆角${it.style.radius} 内边距${it.style.padding}`);
  });
  lines.push(INTENT_HINT[regionIntent] ||
    "用 html_style / html_text / html_move 直接改上面的 id；改完调 html_clean。");
  return lines.join("\n");
}

function renderRegion() {
  if (!ct) return;
  const info = ct.region();
  region = info && info.count ? info : null;
  const count = region ? region.count : 0;
  setText("regionInfo", count
    ? `已圈住 ${count} 个元素${region.parent ? ` · 父级 ${region.parent.id} ${region.parent.tag}` : ""}`
    : "圈选模式打开后，在页面里拖一个框，圈住要改的那一块");
  const toAgent = $("toAgentBtn");
  const copy = $("copyRegionBtn");
  if (toAgent) toAgent.disabled = !count;
  if (copy) copy.disabled = !count;
}

async function sendRegion() {
  const text = regionText();
  if (!text) return;
  const noteEl = $("regionNote");
  const note = noteEl ? noteEl.value.trim() : "";
  try {
    const res = await fetch("/api/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, note, intent: regionIntent, data: region }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || `写入失败（${res.status}）`);
    setStatus(`已写给 agent · ${result.file}`);
  } catch (err) {
    setStatus(`写入失败：${err.message}`, true);
  }
}

async function copyRegion() {
  const text = regionText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("选区文本已复制，直接贴给 agent");
  } catch (err) {
    setStatus(`复制失败：${err.message}`, true);
  }
}

/* ---------------- 撤销 / 重做 ---------------- */

function undo() {
  if (!undoStack.length || !ct) return;
  const id = current && current.id;
  redoStack.push(ct.bodyHtml());
  ct.restore(undoStack.pop());
  if (id) { current = { id }; ct.select(id); } else renderPanel(null);
  syncHistory();
  setStatus("已撤销");
}

function redo() {
  if (!redoStack.length || !ct) return;
  const id = current && current.id;
  undoStack.push(ct.bodyHtml());
  ct.restore(redoStack.pop());
  if (id) { current = { id }; ct.select(id); } else renderPanel(null);
  syncHistory();
  setStatus("已重做");
}

/* ---------------- 保存 / 导出 ---------------- */

/* 整页一键排版：AI 生成的页面字号/间距/圆角常常是随手写的，这里一次收拢。
 * 改动全走 inline（几何类本来就在 inline），拍一张快照进撤销栈，不满意按撤销回去。 */
function polish() {
  if (!ct) return;
  const before = ct.bodyHtml();
  const res = ct.autoLayout();
  if (!res || !res.ok) {
    setStatus((res && res.reason) || "排版失败", true);
    return;
  }
  const st = res.stat || {};
  const total = (st.fontSize || 0) + (st.lineHeight || 0) + (st.spacing || 0) + (st.radius || 0);
  if (!total) {
    setStatus("整页已经对齐了，没有需要收拢的地方");
    return;
  }
  pushUndo(before);
  syncHistory();
  record("layout", { base: res.base, steps: res.steps, stat: st });
  // 面板里的数值变了，把当前选中重新读一遍（这会写一条「已选中」状态，所以放在总结之前）
  const snap = ct.snapshot();
  if (snap && snap.selected && snap.selected.id) renderPanel(ct.select(snap.selected.id));
  setStatus(`已统一 ${total} 处：字号 ${st.fontSize || 0} · 行高 ${st.lineHeight || 0}` +
            ` · 间距 ${st.spacing || 0} · 圆角 ${st.radius || 0}（可撤销）`);
}

async function save() {
  if (!ct) return;
  const html = ct.wholeHtml();
  const body = ct.bodyHtml();
  try {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `保存失败（${res.status}）`);
    lastSavedHtml = body;
    const sync = $("syncBtn");
    if (sync) sync.hidden = true;
    const meta = await readMeta();
    if (meta && typeof meta.mtime === "number") fileMtime = meta.mtime;
    setStatus(`已保存 · ${(data.bytes / 1024).toFixed(1)} KB`);
  } catch (err) {
    setStatus(`保存失败：${err.message}`, true);
  }
}

function exportHtml() {
  if (!ct) return;
  const blob = new Blob([ct.wholeHtml()], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "edited.html";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 导完顺手开一个标签页，能直接点着用（边用边看）
  const tab = window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  setStatus(tab ? "已导出 edited.html，并在新标签页打开" : "已导出 edited.html（新标签被浏览器拦了，去下载目录打开）");
}

/* ---------------- 同步 agent 的改动 ----------------
 * agent 用 MCP 改的是同一个文件，这里轮询 mtime：变了就重载 iframe（面板和备注不动）。
 * 本地还有没保存的改动时不自动覆盖，改成亮一个按钮，让人自己点。
 */

async function readMeta() {
  try {
    const res = await fetch("/api/meta", { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function applyReload() {
  if (!ct) {
    frame.src = "/preview?r=" + Date.now();
    return;
  }
  pendingSnap = ct.snapshot();
  reloading = true;
  frame.src = "/preview?r=" + Date.now();
}

async function pollFile() {
  if (reloading) return;
  if (ct && ct.busy && ct.busy()) return;          // 正在拖拽 / 画框
  const meta = await readMeta();
  if (!meta || typeof meta.mtime !== "number") return;
  if (meta.file) setText("file", meta.file);
  renderPages(meta.pages, meta.file);
  if (!fileMtime) {
    fileMtime = meta.mtime;
    return;
  }
  if (Math.abs(meta.mtime - fileMtime) < 0.001) return;
  fileMtime = meta.mtime;
  if (ct && lastSavedHtml !== null && ct.bodyHtml() !== lastSavedHtml) {
    const sync = $("syncBtn");
    if (sync) sync.hidden = false;
    setStatus("agent 改了文件 · 你本地还有没保存的改动", true);
    return;
  }
  applyReload();
}

/* ---------------- 切页：一级页面做完接着改二级页面 ----------------
 * 页面通常不止一张：导航里链到 about.html / pricing.html 都是独立的单文件。
 * 双击站内 .html 链接，或者用顶栏下拉，就把编辑目标换成那个文件，接着改。
 */

function renderPages(pages, current) {
  const sel = $("pageSel");
  if (!Array.isArray(pages) || pages.length < 2) {
    sel.hidden = true;
    return;
  }
  const sig = pages.join("|");
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = "";
    for (const name of pages) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
    sel.dataset.sig = sig;
  }
  sel.hidden = false;
  if (current) sel.value = current;
}

async function openPage(name) {
  let data;
  try {
    const res = await fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: name }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `切页失败（${res.status}）`);
  } catch (err) {
    setStatus(`切页失败：${err.message}`, true);
    return;
  }
  // 换的是另一个文件：撤销栈、选中、圈选、备注都清掉，别串到别的页面上
  undoStack = [];
  redoStack = [];
  syncHistory();
  pushJournal(true);
  pendingSnap = null;
  pendingHtml = null;
  region = null;
  regionIntent = "";
  const noteBox = $("regionNote");
  if (noteBox) noteBox.value = "";
  const intentRow = $("intentRow");
  if (intentRow) for (const b of intentRow.querySelectorAll("button")) b.classList.remove("on");
  const sync = $("syncBtn");
  if (sync) sync.hidden = true;
  setText("file", data.file);
  fileMtime = data.mtime || 0;
  lastSavedHtml = null;
  renderPages(data.pages, data.file);
  reloading = true;
  frame.src = "/preview?r=" + Date.now();
  setStatus(`已切到 ${data.file}`);
}

// 双击链接时由 iframe 回调（相对路径可能带 ./ ../ 或 #锚点，这里只取文件名这层）
window.__ctNav = (href) => {
  const rel = href.split(/[?#]/)[0].replace(/^\.?\//, "");
  if (rel) openPage(rel);
};

/* ---------------- 面板折叠 ----------------
 * 右侧控件太多、面板太长：把「交互状态 / 效果 / 位置微调 / 换顺序 / 圈选给 agent」
 * 收成可折叠的分组。常用组默认展开，不常用的默认收起；用户点开的状态记在 localStorage。
 */

const SECTION_STATE_KEY = "pt-sections-v1";
const SECTION_DEFAULT = {
  "交互状态": true,
  "效果": true,
  "位置微调": false,
  "换顺序": false,
  "圈选给 agent": true,
};

function setupSections() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SECTION_STATE_KEY) || "{}") || {}; } catch (_) { saved = {}; }
  const panel = document.querySelector(".panel");
  if (!panel) return;
  const groups = [];

  for (const head of Array.from(panel.querySelectorAll("h3.sec"))) {
    const title = head.textContent.trim();
    const group = document.createElement("div");
    group.className = "group";
    let node = head.nextElementSibling;
    // 收组时遇到下一个分节标题，或遇到「元素信息」这条常驻区就停：
    // 元素属性（字号/颜色/圆角这些）从 elInfo 开始，任何分组都不该把它卷进去
    while (node && node.tagName !== "H3" && node.id !== "elInfo" &&
           !(node.querySelector && node.querySelector("#fRadius"))) {
      const next = node.nextElementSibling;
      group.appendChild(node);
      node = next;
    }
    head.after(group);

    const open = Object.prototype.hasOwnProperty.call(saved, title)
      ? !!saved[title] : (SECTION_DEFAULT[title] !== false);
    group.classList.toggle("hide", !open);
    head.classList.add("foldable");
    head.classList.toggle("closed", !open);

    head.addEventListener("click", () => {
      const nowOpen = group.classList.contains("hide");
      group.classList.toggle("hide", !nowOpen);
      head.classList.toggle("closed", !nowOpen);
      saved[title] = nowOpen;
      try { localStorage.setItem(SECTION_STATE_KEY, JSON.stringify(saved)); } catch (_) {}
    });
    groups.push({ title, head, group });
  }

  const foldAll = document.createElement("button");
  foldAll.type = "button";
  foldAll.className = "btn small ghost fold-all";
  foldAll.textContent = "折叠全部";
  const h2 = panel.querySelector("h2");
  if (h2) h2.after(foldAll);
  foldAll.addEventListener("click", () => {
    const anyOpen = groups.some((g) => !g.group.classList.contains("hide"));
    groups.forEach((g) => {
      g.group.classList.toggle("hide", anyOpen);
      g.head.classList.toggle("closed", anyOpen);
      saved[g.title] = !anyOpen;
    });
    foldAll.textContent = anyOpen ? "展开全部" : "折叠全部";
    try { localStorage.setItem(SECTION_STATE_KEY, JSON.stringify(saved)); } catch (_) {}
  });
}

/* ---------------- 启动 ---------------- */

function boot() {
  setupSections();
  frame = $("frame");
  setText("ver", BUILD);
  if (!frame) {
    setStatus("预览区不见了：保存一份带 <iframe id=\"frame\"> 的界面再刷新", true);
    return;
  }
  // 拖拽开始/结束时由 iframe 回调：开始前拍快照，结束后才真正入撤销栈
  window.__ctDragStart = () => { if (ct) pendingHtml = ct.bodyHtml(); };
  window.__ctDragEnd = (payload) => {
    if (pendingHtml !== null) { pushUndo(pendingHtml); pendingHtml = null; }
    const info = payload || {};
    record("move", { mode: info.mode || "reorder",
                     from: info.from, to: info.to, drag: true });
  };
  // iframe 里按方向键时转过来，走同一条 nudge 逻辑
  window.__ctKeyNudge = (dx, dy) => nudge(dx, dy);
  // 圈选完成/清除时由 iframe 回调
  window.__ctRegionChange = () => renderRegion();
  // 浏览模式下点到站外链接，不跟着跳出去
  window.__ctBlocked = (href) => setStatus(`站外链接不在编辑器里跳转：${href}`, true);

  frame.addEventListener("load", () => {
    reloading = false;
    ct = frame.contentWindow.__ct;
    if (!ct) {
      setStatus("注入脚本没跑起来（可能被页面的 CSP 拦了）", true);
      return;
    }
    ct.init();
    ct.setMode(dragMode);
    ct.setRegionMode(regionMode);
    ct.setBrowse(browseMode);
    setStateMode("base");
    if (pendingSnap) {
      const restored = ct.restoreSnap(pendingSnap);
      pendingSnap = null;
      // 外部改动之后再撤销，撤的是别人已经不存在的中间状态，直接清空
      undoStack = [];
      redoStack = [];
      lastSavedHtml = ct.bodyHtml();
      syncHistory();
      renderRegion();
      setStatus(restored ? "已同步 agent 的改动 · 选中已恢复" : "已同步 agent 的改动");
      return;
    }
    renderRegion();
    lastSavedHtml = ct.bodyHtml();
    setStatus(`已加载 · ${BUILD}`);
    syncHistory();
  });

  bindField("fText", (el) => {
    const before = current.text;
    ct.setText(current.id, el.value);
    record("text", { from: before, to: el.value });
  });
  bindField("fFontSize", (el) => applyGeo({ fontSize: el.value ? el.value + "px" : "" }));
  bindField("fFontWeight", (el) => applyGeo({ fontWeight: el.value || "" }));
  bindField("fLineHeight", (el) => applyGeo({ lineHeight: el.value ? el.value + "px" : "" }));
  bindField("fTextAlign", (el) => applyGeo({ textAlign: el.value || "" }));
  bindField("fColor", (el) => applyVisual({ color: el.value }));
  bindField("fBackground", (el) => applyVisual({ background: el.value }));
  bindField("fRadius", (el) => applyVisual({ borderRadius: el.value + "px" }));
  bindField("fOpacity", (el) => {
    setText("opacityVal", el.value);
    applyVisual({ opacity: el.value === "100" ? "" : String(Number(el.value) / 100) });
  });
  bindField("fPadding", (el) => applyGeo({ padding: el.value + "px" }));
  bindField("fMargin", (el) => applyGeo({ margin: el.value + "px" }));
  bindField("fWidth", (el) => applyGeo({ width: el.value ? el.value + "px" : "" }));
  bindField("fLeft", (el) => {
    const o = ct.offset(current.id);
    ct.setOffset(current.id, Number(el.value) || 0, o ? o.top : 0);
  });
  bindField("fTop", (el) => {
    const o = ct.offset(current.id);
    ct.setOffset(current.id, o ? o.left : 0, Number(el.value) || 0);
  });

  on("stateSeg", "click", (e) => {
    const btn = e.target.closest("[data-state]");
    if (!btn) return;
    setStateMode(btn.dataset.state);
  });

  on("dragMode", "click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    setDragMode(btn.dataset.mode);
  });

  // 浏览 / 点击捕获
  on("browseBtn", "click", () => setBrowse(!browseMode));
  on("captureBtn", "click", startCapture);

  // 面板里点上下级 chip 直接跳过去选中
  on("elPath", "click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip || !ct) return;
    const info = ct.select(chip.dataset.id);
    renderPanel(info);
    setStatus(`已选中 ${info ? info.tag : ""} · ${BUILD}`);
  });

  // 选中的是链接 → 直接进它指向的次级页面
  on("gotoPageBtn", "click", () => {
    if (current && current.link && current.link.page) openPage(current.link.page);
  });

  const nudgeBox = document.querySelector(".nudge");
  if (nudgeBox) nudgeBox.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-nudge]");
    if (!btn) return;
    const [dx, dy] = btn.dataset.nudge.split(",").map(Number);
    nudge(dx, dy);
  });

  on("zeroOffset", "click", () => {
    if (!current) return;
    pushUndo(ct.bodyHtml());
    ct.zeroOffset(current.id);
    reselect();
    setStatus("已归零偏移");
  });

  on("clearBg", "click", () => {
    if (!current) return;
    pushUndo(ct.bodyHtml());
    applyVisual({ background: "" });
    const bg = $("fBackground");
    if (bg) bg.value = "#ffffff";
    setStatus("已清除背景");
  });

  on("gradRow", "click", (e) => {
    const btn = e.target.closest("[data-grad]");
    if (!btn || !current) return;
    pushUndo(ct.bodyHtml());
    applyVisual({ background: btn.dataset.grad });
    refreshPanel();
    setStatus(`已套渐变 · ${btn.title}`);
  });

  on("applyGrad", "click", () => {
    if (!current) return;
    const angle = $("fGradAngle");
    const from = $("fGradFrom");
    const to = $("fGradTo");
    if (!angle || !from || !to) return;
    pushUndo(ct.bodyHtml());
    const a = Number(angle.value) || 135;
    const fromC = from.value;
    const toC = to.value;
    applyVisual({ background: `linear-gradient(${a}deg, ${fromC} 0%, ${toC} 100%)` });
    refreshPanel();
    setStatus(stateMode === "hover" ? "已设置悬停渐变" : "已设置渐变");
  });

  on("clearGrad", "click", () => {
    if (!current) return;
    pushUndo(ct.bodyHtml());
    applyVisual({ background: "" });
    refreshPanel();
    setStatus("已清除渐变");
  });

  on("shadowRow", "click", (e) => {
    const btn = e.target.closest("[data-shadow]");
    if (!btn || !current) return;
    pushUndo(ct.bodyHtml());
    applyVisual({ boxShadow: btn.dataset.shadow });
    refreshPanel();
    setStatus(btn.dataset.shadow ? "已设置阴影" : "已清除阴影");
  });

  on("hoverRow", "click", (e) => {
    const btn = e.target.closest("[data-hover]");
    if (!btn) return;
    hoverPreset(btn.dataset.hover);
  });

  on("regionBtn", "click", () => {
    regionMode = !regionMode;
    if (ct) ct.setRegionMode(regionMode);
    $("regionBtn").textContent = regionMode ? "退出圈选" : "圈选区域";
    $("regionBtn").classList.toggle("primary", regionMode);
    setStatus(regionMode ? "圈选模式：在页面里拖框" : `已退出圈选 · ${BUILD}`);
  });

  on("clearRegionBtn", "click", () => {
    if (ct) ct.clearRegion();
    region = null;
    renderRegion();
    setStatus("已清除选区");
  });

  on("toAgentBtn", "click", sendRegion);
  on("copyRegionBtn", "click", copyRegion);

  // 意图：让 agent 不用从自由文本里猜这次是要改样式、改文案还是加东西
  on("intentRow", "click", (e) => {
    const btn = e.target.closest("[data-intent]");
    if (!btn) return;
    regionIntent = regionIntent === btn.dataset.intent ? "" : btn.dataset.intent;
    for (const b of $("intentRow").querySelectorAll("button")) {
      b.classList.toggle("on", b.dataset.intent === regionIntent);
    }
    setStatus(regionIntent ? `要让 agent：${INTENT[regionIntent]}` : "已取消意图");
  });

  on("syncBtn", "click", () => {
    $("syncBtn").hidden = true;
    applyReload();
  });

  on("parentBtn", "click", () => {
    if (!current) return;
    const info = ct.parent();
    if (info) renderPanel(info);
  });

  on("resetBtn", "click", () => {
    if (!current) return;
    pushUndo(ct.bodyHtml());
    ct.reset(current.id);
    reselect();
    record("reset", {});
    setStatus("已重置该元素");
  });

  // 删除当前元素：先拍撤销快照，删完清空面板；撤销可以整段恢复
  on("deleteBtn", "click", () => {
    if (!current || !ct) return;
    const { id, tag } = current;
    const label = labelOf(current);      // remove 会清掉选中，先把 id/tag 记下来给 agent
    if (tag === "body" || tag === "html") {
      setStatus("body / html 不能删", true);
      return;
    }
    pushUndo(ct.bodyHtml());
    if (!ct.remove(id)) {
      setStatus("没删掉：这个元素已经不在页面上了", true);
      return;
    }
    record("delete", label);
    renderPanel(null);
    setStatus(`已删除 ${id} · ${tag}（可撤销）`);
  });

  const reorder = (dir) => {
    if (!current) return;
    pushUndo(ct.bodyHtml());
    if (ct.move(current.id, dir)) {
      record("move", { dir });
      reselect();
    } else {
      setStatus(dir === "up" ? "已经是第一个了" : "已经是最后一个了");
    }
  };
  on("upBtn", "click", () => reorder("up"));
  on("downBtn", "click", () => reorder("down"));

  on("undoBtn", "click", undo);
  on("redoBtn", "click", redo);
  on("saveBtn", "click", save);
  on("exportBtn", "click", exportHtml);

  on("device", "change", (e) => {
    frame.style.width = e.target.value + "px";
  });

  on("polishBtn", "click", polish);

  // 顶栏切页：下拉里是同一目录树下的所有 html
  on("pageSel", "change", (e) => {
    if (e.target.value) openPage(e.target.value);
  });

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;

    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if (e.key.toLowerCase() === "z" && e.shiftKey) { e.preventDefault(); redo(); }
      return;
    }

    if (!current) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft") { e.preventDefault(); nudge(-step, 0); }
    else if (e.key === "ArrowRight") { e.preventDefault(); nudge(step, 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); nudge(0, -step); }
    else if (e.key === "ArrowDown") { e.preventDefault(); nudge(0, step); }
  });

  pollFile();
  setInterval(pollFile, 1200);

  window.__frame = frame;
}

if (!IS_PREVIEW) boot();
