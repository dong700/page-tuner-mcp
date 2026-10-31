/* 页面精修器 · 注入脚本（运行在 iframe 内）
 *
 * 职责：
 *   1. 给每个可见元素一个稳定 id（data-ct-id）
 *   2. 点谁选谁，画一个高亮框
 *   3. 按父窗口指令改样式 / 文字 / 顺序
 *   4. 把当前 body 的 HTML 交出去（保存 / 撤销都用它）
 *
 * 样式分两层：
 *   - 几何类（字号、行高、内边距、宽度、left/top）走 inline，改一次就定型，简单可靠。
 *   - 视觉类（颜色、背景/渐变、透明度、阴影、圆角、transform、transition）走
 *     「唯一类名 + 注入的 <style data-pt> 块」。inline 优先级最高且表达不了 :hover，
 *     所以写规则前必须把同名 inline 属性摘掉，否则悬停样式永远不生效。
 *
 * 为什么不给自由拖动：页面是文档流，拖动会让后面的块塌陷、重叠。
 */
(function () {
  if (window.__ct) return;

  var STATE = { selected: null, seq: 0, hl: null, mode: "reorder", state: "base",
                region: null, regionMode: false, regionEls: [], browse: false };
  // 每个元素第一次被改之前的 style 属性，用于「重置该元素」
  var ORIG = {};

  /* ---------- 样式层：唯一类名 + 注入 <style> 块 ---------- */

  var PT_RE = /^pt-\d+$/;
  var INLINE_DROP = {
    background: ["background", "background-color", "background-image"],
    "background-color": ["background", "background-color", "background-image"],
    color: ["color"],
    opacity: ["opacity"],
    "box-shadow": ["box-shadow"],
    transform: ["transform"],
    transition: ["transition"],
    "border-radius": ["border-radius"],
    "border-color": ["border-color", "border"],
    border: ["border", "border-color", "border-width", "border-style"],
    filter: ["filter"],
    "backdrop-filter": ["backdrop-filter"],
    "text-shadow": ["text-shadow"],
    "letter-spacing": ["letter-spacing"],
  };

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function kebab(key) {
    return String(key).replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); });
  }

  // 主样式块：跟着文件一起保存，绝不能当成编辑器内部垃圾剔掉
  function ptBlock() {
    var block = document.querySelector("style[data-pt]");
    if (block) return block;
    block = document.createElement("style");
    block.setAttribute("data-pt", "1");
    document.body.appendChild(block);
    return block;
  }

  // 预览块：只是为了让「悬停」状态在编辑时能一直演示，保存/导出时会被剔除
  function previewBlock() {
    var block = document.querySelector("style[data-pt-preview]");
    if (block) return block;
    block = document.createElement("style");
    block.setAttribute("data-pt-preview", "1");
    block.setAttribute("data-ct-internal", "1");
    document.body.appendChild(block);
    return block;
  }

  function parseCss(text) {
    var out = [];
    var re = /([^{}]+)\{([^{}]*)\}/g;
    var m;
    while ((m = re.exec(text))) {
      var sel = m[1].trim();
      if (!sel) continue;
      var decls = [];
      var parts = m[2].split(";");
      for (var i = 0; i < parts.length; i++) {
        var idx = parts[i].indexOf(":");
        if (idx < 0) continue;
        var k = parts[i].slice(0, idx).trim();
        var v = parts[i].slice(idx + 1).trim();
        if (k && v) decls.push([k, v]);
      }
      out.push({ sel: sel, decls: decls });
    }
    return out;
  }

  function cssText(rules) {
    var out = [];
    for (var i = 0; i < rules.length; i++) {
      if (!rules[i].decls.length) continue;
      var body = "";
      for (var j = 0; j < rules[i].decls.length; j++) {
        body += rules[i].decls[j][0] + ": " + rules[i].decls[j][1] + "; ";
      }
      out.push(rules[i].sel + " { " + body.replace(/ $/, "") + " }");
    }
    return out.join("\n");
  }

  function findRule(rules, sel) {
    for (var i = 0; i < rules.length; i++) if (rules[i].sel === sel) return rules[i];
    return null;
  }

  function declsOf(rules, sel) {
    var rule = findRule(rules, sel);
    if (!rule) return null;
    var obj = {};
    for (var i = 0; i < rule.decls.length; i++) obj[rule.decls[i][0]] = rule.decls[i][1];
    return obj;
  }

  // 合并写入：同名覆盖，空值删除
  function setDecls(rules, sel, props) {
    var rule = findRule(rules, sel);
    if (!rule) {
      rule = { sel: sel, decls: [] };
      rules.push(rule);
    }
    for (var key in props) {
      if (!has(props, key)) continue;
      var val = props[key] == null ? "" : String(props[key]);
      var hit = -1;
      for (var i = 0; i < rule.decls.length; i++) {
        if (rule.decls[i][0].toLowerCase() === key.toLowerCase()) { hit = i; break; }
      }
      if (hit >= 0) {
        if (val === "") rule.decls.splice(hit, 1);
        else rule.decls[hit][1] = val;
      } else if (val !== "") {
        rule.decls.push([key, val]);
      }
    }
    return rule;
  }

  function ptClass(el) {
    for (var i = 0; i < el.classList.length; i++) {
      if (PT_RE.test(el.classList[i])) return el.classList[i];
    }
    return null;
  }

  function ensurePtClass(el) {
    var cur = ptClass(el);
    if (cur) return cur;
    var max = 0;
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var cls = all[i].className;
      if (typeof cls !== "string") continue;
      var re = /(?:^|\s)pt-(\d+)(?=\s|$)/g;
      var m;
      while ((m = re.exec(cls))) max = Math.max(max, parseInt(m[1], 10));
    }
    var name = "pt-" + (max + 1);
    el.classList.add(name);
    return name;
  }

  // 两段类名提高权重：(0,2,0)，压住页面里的组件类，又不用 !important
  function selOf(cls, state) {
    var tail = "";
    if (state === "hover") tail = ":hover";
    else if (state === "active") tail = ":active";
    return "." + cls + "." + cls + tail;
  }

  function dropInline(el, prop) {
    var names = INLINE_DROP[String(prop).toLowerCase()] || [prop];
    for (var i = 0; i < names.length; i++) el.style.removeProperty(names[i]);
    if (el.getAttribute("style") === "") el.removeAttribute("style");
  }

  // 元素 inline 上的同名基础值（含简写/长写一组），用来在写 hover 规则前搬到 base 规则里
  function inlineBase(el, prop) {
    var names = INLINE_DROP[String(prop).toLowerCase()] || [prop];
    for (var i = 0; i < names.length; i++) {
      var value = el.style.getPropertyValue(names[i]);
      if (value) return value;
    }
    return "";
  }

  function syncPreview() {
    var el = STATE.selected;
    var prev = document.querySelectorAll(".pt-preview");
    for (var i = 0; i < prev.length; i++) prev[i].classList.remove("pt-preview");
    var block = document.querySelector("style[data-pt-preview]");
    var main = document.querySelector("style[data-pt]");
    var cls = el && STATE.state === "hover" ? ptClass(el) : null;
    var decls = cls && main ? declsOf(parseCss(main.textContent), selOf(cls, "hover")) : null;
    // 没有要预演的东西就别留一个空块，否则文件里会多一个 <style>
    if (!decls) {
      if (block) block.remove();
      return;
    }
    var body = "";
    for (var key in decls) {
      if (has(decls, key)) body += key + ": " + decls[key] + " !important; ";
    }
    el.classList.add("pt-preview");
    previewBlock().textContent = "." + cls + "." + cls + ".pt-preview { " + body + " }";
  }

  // 写回主样式块；规则全空时把块删掉，文件里不留一个空 <style>
  function commitRules(rules) {
    var live = [];
    for (var i = 0; i < rules.length; i++) if (rules[i].decls.length) live.push(rules[i]);
    var block = document.querySelector("style[data-pt]");
    if (!live.length) {
      if (block) block.remove();
      return;
    }
    if (!block) block = ptBlock();
    block.textContent = cssText(live);
  }

  var SKIP_TAGS = /^(script|style|link|meta|head|title|noscript|br|template)$/i;

  function editable(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.test(tag)) return false;
    if (tag === "html" || tag === "body") return false;
    if (el.getAttribute("data-ct-internal") === "1") return false;
    if (!el.hasAttribute("data-ct-id")) return false;
    return true;
  }

  // 两趟：先扫出已有 id 的最大值，再补号。一趟边扫边 ++max 会跟文档后面已有的 id 撞号
  // （页面里若已存在 data-ct-id="e0"，前面的新元素也会拿到 e0，findBy 取第一个 → 改错元素）
  function tagIds() {
    var all = document.body.querySelectorAll("*");
    var max = -1;
    var i;
    for (i = 0; i < all.length; i++) {
      var el = all[i];
      if (SKIP_TAGS.test(el.tagName) || el.getAttribute("data-ct-internal") === "1") continue;
      var id = el.getAttribute("data-ct-id");
      if (id && /^e\d+$/.test(id)) max = Math.max(max, parseInt(id.slice(1), 10));
    }
    for (i = 0; i < all.length; i++) {
      var node = all[i];
      if (SKIP_TAGS.test(node.tagName) || node.getAttribute("data-ct-internal") === "1") continue;
      if (!node.hasAttribute("data-ct-id")) node.setAttribute("data-ct-id", "e" + (++max));
    }
    STATE.seq = max + 1;
  }

  function ensureHighlight() {
    if (STATE.hl && STATE.hl.isConnected) return STATE.hl;
    var box = document.createElement("div");
    box.setAttribute("data-ct-internal", "1");
    box.style.cssText = [
      "position:fixed", "pointer-events:none", "z-index:2147483647",
      "border:2px solid #6366f1", "border-radius:2px",
      "box-shadow:0 0 0 1px rgba(255,255,255,.9), 0 0 0 3px rgba(99,102,241,.25)",
      "display:none", "box-sizing:border-box", "transition:none",
    ].join(";");
    document.documentElement.appendChild(box);
    STATE.hl = box;
    return box;
  }

  function drawHighlight() {
    var box = ensureHighlight();
    var el = STATE.selected;
    // 浏览模式下一律不画框，免得蓝色框挡住要点的按钮
    if (STATE.browse || !el || !el.isConnected) {
      box.style.display = "none";
      return;
    }
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) {
      box.style.display = "none";
      return;
    }
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  }

  function directText(el) {
    var text = "";
    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i];
      if (node.nodeType === 3) text += node.textContent;
    }
    return text.trim();
  }

  function px(value) {
    var n = parseFloat(value);
    return isFinite(n) ? n : 0;
  }

  function describe(el) {
    if (!el) return null;
    var cs = getComputedStyle(el);
    var cls = ptClass(el);
    var block = document.querySelector("style[data-pt]");
    var rules = block ? parseCss(block.textContent) : [];
    var base = cls ? declsOf(rules, selOf(cls, "base")) : null;
    var hover = cls ? declsOf(rules, selOf(cls, "hover")) : null;
    var active = cls ? declsOf(rules, selOf(cls, "active")) : null;
    var parentEl = el.parentElement;
    var kids = [];
    for (var i = 0; i < el.children.length && kids.length < 12; i++) {
      var kid = el.children[i];
      var kidId = kid.getAttribute("data-ct-id");
      if (!kidId) continue;
      kids.push({ id: kidId, tag: kid.tagName.toLowerCase(),
                  text: directText(kid).slice(0, 18) });
    }
    // 选中链接时告诉编辑器它指向哪个站内页面，面板上就能直接「去这一页」
    var link = null;
    if (el.tagName === "A") {
      var rawHref = el.getAttribute("href") || "";
      var local = localHref(el);
      link = {
        href: rawHref,
        page: local ? local.split(/[?#]/)[0].replace(/^\.?\//, "") : "",
      };
    }
    return {
      id: el.getAttribute("data-ct-id"),
      tag: el.tagName.toLowerCase(),
      cls: typeof el.className === "string" ? el.className : "",
      text: directText(el),
      hasChildren: el.children.length > 0,
      parent: parentEl ? { id: parentEl.getAttribute("data-ct-id") || "",
                          tag: parentEl.tagName.toLowerCase(),
                          cls: classOf(parentEl) } : null,
      kids: kids,
      link: link,
      pt: cls,
      rules: { base: base || {}, hover: hover || {}, active: active || {} },
      hasHover: !!hover,
      hasActive: !!active,
      sheet: {
        fontSize: px(cs.fontSize),
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight === "normal" ? "" : px(cs.lineHeight),
        color: cs.color,
        background: cs.backgroundColor,
        backgroundImage: cs.backgroundImage,
        radius: px(cs.borderTopLeftRadius),
        paddingTop: px(cs.paddingTop),
        paddingLeft: px(cs.paddingLeft),
        marginTop: px(cs.marginTop),
        width: px(cs.width),
        height: px(cs.height),
        opacity: Math.round((parseFloat(cs.opacity) || 1) * 100),
        shadow: cs.boxShadow === "none" ? "" : cs.boxShadow,
        borderColor: cs.borderColor,
        transform: cs.transform === "none" ? "" : cs.transform,
        textAlign: cs.textAlign,
        display: cs.display,
        position: cs.position,
        left: parseFloat(cs.left) || 0,
        top: parseFloat(cs.top) || 0,
      },
    };
  }

  function pick(el) {
    if (!editable(el)) return;
    STATE.selected = el;
    drawHighlight();
    if (STATE.state === "hover") syncPreview();
    // 方向键要能收到：主动把焦点拿回 iframe 文档，但不许它自动滚动
    try { document.documentElement.focus({ preventScroll: true }); } catch (_) {}
    if (typeof window.parent.__ctPick === "function") {
      try { window.parent.__ctPick(describe(el)); } catch (_) {}
    }
  }

  function findBy(id) {
    return document.querySelector('[data-ct-id="' + id + '"]');
  }

  // 重载后用「id → 标签+类名+文字」逐级降级匹配，把选中恢复回来。
  // agent 改文件时会 html_clean 掉 data-ct-id，重载后 id 可能整体错位，只认 id 会丢选中。
  function findLike(snap) {
    var el = snap.id ? findBy(snap.id) : null;
    if (el && (!snap.tag || el.tagName.toLowerCase() === snap.tag)) return el;
    var all = document.querySelectorAll("[data-ct-id]");
    var loose = null;
    for (var i = 0; i < all.length; i++) {
      var node = all[i];
      if (!editable(node)) continue;
      if (snap.tag && node.tagName.toLowerCase() !== snap.tag) continue;
      if (classOf(node) !== snap.cls) continue;
      if (directText(node).slice(0, 40) === snap.text) return node;
      if (!loose) loose = node;
    }
    return loose;
  }

  /* ---------- 圈选区域 ----------
   * 给人用，但产物是给 agent 的：框一块地方，这里算出「框住了哪些元素」，
   * 由父窗口拼成一句紧凑文字。agent 靠结构 + 文字认位置，不需要看截图、也不需要别的模型。
   */

  var MARQ = null;

  function regionLayer() {
    var layer = document.getElementById("ct-region");
    if (layer && layer.isConnected) return layer;
    layer = document.createElement("div");
    layer.id = "ct-region";
    layer.setAttribute("data-ct-internal", "1");
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    document.documentElement.appendChild(layer);
    return layer;
  }

  function mark(color, dashed, bg) {
    var d = document.createElement("div");
    d.setAttribute("data-ct-internal", "1");
    d.style.cssText = "position:fixed;pointer-events:none;box-sizing:border-box;" +
      "border:" + (dashed ? "1px dashed " : "1px solid ") + color + ";" +
      "background:" + (bg || "transparent") + ";";
    return d;
  }

  function place(node, left, top, width, height) {
    node.style.left = left + "px";
    node.style.top = top + "px";
    node.style.width = width + "px";
    node.style.height = height + "px";
    return node;
  }

  // 选框存页面坐标，滚动时再换算回视口，位置才跟得住
  function drawRegion() {
    var layer = regionLayer();
    layer.innerHTML = "";
    var r = STATE.region;
    if (!r) return;
    var left = r.left - window.scrollX;
    var top = r.top - window.scrollY;
    layer.appendChild(place(mark("#4f46e5", true, "rgba(79,70,229,.06)"),
      left, top, r.right - r.left, r.bottom - r.top));
    for (var i = 0; i < STATE.regionEls.length; i++) {
      var el = STATE.regionEls[i];
      if (!el.isConnected) continue;
      var b = el.getBoundingClientRect();
      layer.appendChild(place(mark("rgba(79,70,229,.5)", false, "rgba(79,70,229,.04)"),
        b.left, b.top, b.width, b.height));
    }
  }

  function startMarquee(e) {
    STATE.region = null;
    STATE.regionEls = [];
    var layer = regionLayer();
    layer.innerHTML = "";
    var box = mark("#4f46e5", true, "rgba(79,70,229,.1)");
    box.id = "ct-marquee";
    box.style.display = "none";
    layer.appendChild(box);
    MARQ = { x: e.clientX, y: e.clientY, rect: null, box: box };
  }

  function moveMarquee(e) {
    if (!MARQ) return;
    var sx = window.scrollX;
    var sy = window.scrollY;
    var x0 = Math.min(MARQ.x, e.clientX);
    var y0 = Math.min(MARQ.y, e.clientY);
    var x1 = Math.max(MARQ.x, e.clientX);
    var y1 = Math.max(MARQ.y, e.clientY);
    MARQ.rect = { left: x0 + sx, top: y0 + sy, right: x1 + sx, bottom: y1 + sy };
    MARQ.box.style.display = "block";
    place(MARQ.box, x0, y0, x1 - x0, y1 - y0);
  }

  function boxOf(el) {
    var r = el.getBoundingClientRect();
    return {
      left: r.left + window.scrollX,
      top: r.top + window.scrollY,
      right: r.right + window.scrollX,
      bottom: r.bottom + window.scrollY,
      width: r.width,
      height: r.height,
    };
  }

  // 必须整个落在框里（留 2px 容差）。用"包含"而不是"重叠面积过半"：
  // 框住一行卡片时，外层 section/wrap 往往也有一大半落在框里，松一点它就先被选中了。
  function insideFrame(el, rect) {
    var b = boxOf(el);
    if (!b.width || !b.height) return false;
    return b.left >= rect.left - 2 && b.top >= rect.top - 2 &&
      b.right <= rect.right + 2 && b.bottom <= rect.bottom + 2;
  }

  // 纯布局容器：子元素几乎把它的盒子填满。框住一行卡片时用户想选的是那几张卡，
  // 不是外面那个 div，所以这层要往下走一步。
  function packedChildren(el, rect) {
    var kids = [];
    var minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (!editable(c) || !insideFrame(c, rect)) continue;
      var b = boxOf(c);
      kids.push(c);
      minL = Math.min(minL, b.left);
      minT = Math.min(minT, b.top);
      maxR = Math.max(maxR, b.right);
      maxB = Math.max(maxB, b.bottom);
    }
    if (kids.length < 2) return null;
    var me = boxOf(el);
    if (!me.width || !me.height) return null;
    if (maxR - minL < me.width * 0.85 || maxB - minT < me.height * 0.85) return null;
    return kids;
  }

  // 命中规则：只收整个落在框里的元素 → 只保留最外层（避免把卡片里的 h3/p 全算进来）
  // → 若最外层只剩一个纯布局容器，再往下走一层
  function hitRegion(rect) {
    var all = document.querySelectorAll("[data-ct-id]");
    var hits = [];
    var i;
    for (i = 0; i < all.length; i++) {
      var el = all[i];
      if (!editable(el)) continue;
      if (!insideFrame(el, rect)) continue;
      hits.push(el);
    }
    var outer = [];
    for (i = 0; i < hits.length; i++) {
      var node = hits[i].parentElement;
      var nested = false;
      while (node && node !== document.body) {
        if (hits.indexOf(node) >= 0) { nested = true; break; }
        node = node.parentElement;
      }
      if (!nested) outer.push(hits[i]);
    }
    for (var depth = 0; depth < 4 && outer.length === 1; depth++) {
      var kids = packedChildren(outer[0], rect);
      if (!kids) break;
      outer = kids;
    }
    if (outer.length > 40) {
      var keep = outer.slice();
      keep.sort(function (a, b) {
        var x = a.getBoundingClientRect();
        var y = b.getBoundingClientRect();
        return y.width * y.height - x.width * x.height;
      });
      keep = keep.slice(0, 40);
      outer = outer.filter(function (el) { return keep.indexOf(el) >= 0; });
    }
    return outer;
  }

  function commonParent(els) {
    if (!els.length) return null;
    var chain = [];
    var node = els[0].parentElement;
    while (node && node !== document.documentElement) {
      chain.push(node);
      node = node.parentElement;
    }
    for (var i = 1; i < els.length; i++) {
      var cur = els[i].parentElement;
      while (cur && chain.indexOf(cur) < 0) cur = cur.parentElement;
      if (!cur) return null;
      chain = chain.slice(chain.indexOf(cur));
    }
    return chain[0] || null;
  }

  function classOf(el) {
    var cls = typeof el.className === "string" ? el.className : "";
    return cls.split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
  }

  function brief(el) {
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    return {
      id: el.getAttribute("data-ct-id"),
      tag: el.tagName.toLowerCase(),
      cls: classOf(el),
      text: directText(el).slice(0, 40),
      size: [Math.round(r.width), Math.round(r.height)],
      style: {
        fontSize: Math.round(px(cs.fontSize)),
        color: cs.color,
        background: cs.backgroundColor,
        radius: Math.round(px(cs.borderTopLeftRadius)),
        padding: Math.round(px(cs.paddingTop)),
        display: cs.display,
        gap: cs.gap === "normal" ? "" : cs.gap,
      },
    };
  }

  function describeRegion() {
    var parent = commonParent(STATE.regionEls);
    return {
      rect: STATE.region,
      count: STATE.regionEls.length,
      parent: parent ? brief(parent) : null,
      items: STATE.regionEls.map(brief),
    };
  }

  function clearRegion(silent) {
    STATE.region = null;
    STATE.regionEls = [];
    MARQ = null;
    var layer = document.getElementById("ct-region");
    if (layer) layer.remove();
    if (!silent) parentCall("__ctRegionChange");
    return true;
  }

  /* ---------- 拖动 ----------
   * 默认 = 重排：显示插入线，松手插到该位置，其他元素自动让位（不会塌陷）。
   * 按住 Alt = 偏移：relative + left/top 做视觉位移，原位置保留（可能重叠，但不影响别人）。
   * 不做绝对定位自由拖 —— 那是画布工具的事，在文档流里会把布局拆散。
   */

  var DRAG = null;
  var GUIDE = null;
  var GHOST = null;
  var ZERO = {};                 // 记录哪些元素是被我们改成 relative 的

  function parentCall(name) {
    try {
      if (typeof window.parent[name] === "function") {
        window.parent[name].apply(window.parent, Array.prototype.slice.call(arguments, 1));
      }
    } catch (_) {}
  }

  function guideBox() {
    if (GUIDE && GUIDE.isConnected) return GUIDE;
    GUIDE = document.createElement("div");
    GUIDE.setAttribute("data-ct-internal", "1");
    GUIDE.style.cssText =
      "position:fixed;z-index:2147483646;background:#6366f1;border-radius:2px;" +
      "box-shadow:0 0 0 1px rgba(255,255,255,.8);display:none;pointer-events:none;";
    document.documentElement.appendChild(GUIDE);
    return GUIDE;
  }

  function startGhost(el) {
    var r = el.getBoundingClientRect();
    var g = el.cloneNode(true);
    g.setAttribute("data-ct-internal", "1");
    g.removeAttribute("data-ct-id");
    var inner = g.querySelectorAll("[data-ct-id]");
    for (var i = 0; i < inner.length; i++) inner[i].removeAttribute("data-ct-id");
    var s = g.style;
    s.position = "fixed";
    s.left = r.left + "px";
    s.top = r.top + "px";
    s.width = r.width + "px";
    s.height = r.height + "px";
    s.margin = "0";
    s.opacity = "0.92";
    s.pointerEvents = "none";
    s.zIndex = "2147483645";
    s.transform = "none";
    // 挂在原父容器里，才能继承它那条 CSS 选择器的样式
    el.parentElement.appendChild(g);
    GHOST = g;
  }

  function siblings() {
    var parent = DRAG.el.parentElement;
    var list = [];
    for (var i = 0; i < parent.children.length; i++) {
      var c = parent.children[i];
      if (c === DRAG.el || c.getAttribute("data-ct-internal") === "1") continue;
      var r = c.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      list.push({ el: c, r: r });
    }
    return list;
  }

  function axisOf(parent) {
    var cs = getComputedStyle(parent);
    if ((cs.display === "flex" || cs.display === "inline-flex") && cs.flexDirection.indexOf("row") === 0) return "x";
    if (cs.display === "grid") {
      var cols = (cs.gridTemplateColumns || "").trim().split(/\s+/);
      if (cols.length > 1) return "x";
    }
    return "y";
  }

  function updateGuide(x, y) {
    var list = siblings();
    var axis = axisOf(DRAG.el.parentElement);
    var before = null;
    for (var i = 0; i < list.length; i++) {
      var k = list[i];
      var mid = axis === "x" ? k.r.left + k.r.width / 2 : k.r.top + k.r.height / 2;
      if ((axis === "x" ? x : y) < mid) { before = k; break; }
    }
    DRAG.before = before;

    var box = guideBox();
    var last = list.length ? list[list.length - 1] : null;
    if (!before && !last) { box.style.display = "none"; return; }

    box.style.display = "block";
    if (axis === "x") {
      box.style.left = (before ? before.r.left - 2 : last.r.right - 2) + "px";
      box.style.top = (before ? before.r.top : last.r.top) + "px";
      box.style.width = "4px";
      box.style.height = (before ? before.r.height : last.r.height) + "px";
    } else {
      box.style.left = (before ? before.r.left : last.r.left) + "px";
      box.style.top = (before ? before.r.top - 2 : last.r.bottom - 2) + "px";
      box.style.width = (before ? before.r.width : last.r.width) + "px";
      box.style.height = "4px";
    }
  }

  // 挪位置模式：开始拖动时记下起点，之后实时跟随鼠标（元素本体在动，不用 ghost）
  function beginOffset(el) {
    var cs = getComputedStyle(el);
    if (cs.position === "static") {
      ZERO[el.getAttribute("data-ct-id")] = true;
      el.style.position = "relative";
    }
    DRAG.baseLeft = parseFloat(cs.left) || 0;
    DRAG.baseTop = parseFloat(cs.top) || 0;
  }

  function cleanupDrag() {
    if (GHOST && GHOST.parentElement) GHOST.remove();
    GHOST = null;
    if (GUIDE) GUIDE.style.display = "none";
    if (DRAG && DRAG.el) {
      if (DRAG.origOpacity) DRAG.el.style.opacity = DRAG.origOpacity;
      else DRAG.el.style.removeProperty("opacity");
      // 恢复透明度后可能剩下一个空 style=""，会跟着导出文件走，清掉
      if (DRAG.el.getAttribute("style") === "") DRAG.el.removeAttribute("style");
    }
    DRAG = null;
  }

  /* ---------- 事件：用委托，restore 之后不用重绑 ---------- */

  document.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    // 浏览模式：所有事件都让页面自己处理，点按钮就是真的点按钮
    if (STATE.browse) return;
    if (STATE.regionMode) {
      e.preventDefault();
      e.stopPropagation();
      startMarquee(e);
      return;
    }
    var node = e.target;
    while (node && node.nodeType === 1 && !editable(node)) node = node.parentElement;
    if (!node || !editable(node)) return;
    e.preventDefault();
    e.stopPropagation();
    pick(node);

    var r = node.getBoundingClientRect();
    DRAG = {
      el: node,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: r.left,
      startTop: r.top,
      moved: false,
      mode: "reorder",
      before: null,
      origOpacity: node.style.opacity,
    };
  }, true);

  // 双击站内 .html 链接 → 交给编辑器切页。iframe 自己导航会 404（只有 /preview 一个入口）
  function localHref(a) {
    var href = (a.getAttribute("href") || "").trim();
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.indexOf("//") >= 0) return null;
    if (!/\.html?([?#]|$)/i.test(href)) return null;
    return href;
  }

  document.addEventListener("dblclick", function (e) {
    var node = e.target;
    while (node && node.nodeType === 1 && node.tagName !== "A") node = node.parentElement;
    if (!node || node.tagName !== "A") return;
    var href = localHref(node);
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    parentCall("__ctNav", href);
  }, true);

  window.addEventListener("pointermove", function (e) {
    if (MARQ) { moveMarquee(e); return; }
    if (!DRAG) return;
    var dx = e.clientX - DRAG.startX;
    var dy = e.clientY - DRAG.startY;

    if (!DRAG.moved) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      DRAG.moved = true;
      DRAG.mode = e.altKey ? "offset" : (STATE.mode || "reorder");
      parentCall("__ctDragStart");
      if (DRAG.mode === "offset") {
        beginOffset(DRAG.el);
      } else {
        startGhost(DRAG.el);
        DRAG.el.style.opacity = "0.35";
      }
    }

    if (DRAG.mode === "offset") {
      // 元素本体实时跟手，不用 ghost；其他元素完全不动
      DRAG.el.style.left = (DRAG.baseLeft + dx) + "px";
      DRAG.el.style.top = (DRAG.baseTop + dy) + "px";
      drawHighlight();
      if (GUIDE) GUIDE.style.display = "none";
    } else {
      updateGuide(e.clientX, e.clientY);
      if (GHOST) {
        GHOST.style.left = (DRAG.startLeft + dx) + "px";
        GHOST.style.top = (DRAG.startTop + dy) + "px";
      }
    }
  });

  window.addEventListener("pointerup", function (e) {
    if (MARQ) {
      var rect = MARQ.rect;
      if (MARQ.box && MARQ.box.parentElement) MARQ.box.remove();
      MARQ = null;
      // 太小的框当成误触，直接清掉
      if (!rect || rect.right - rect.left < 8 || rect.bottom - rect.top < 8) {
        clearRegion(true);
        return;
      }
      STATE.region = rect;
      STATE.regionEls = hitRegion(rect);
      drawRegion();
      parentCall("__ctRegionChange");
      return;
    }
    if (!DRAG) return;
    if (!DRAG.moved) { cleanupDrag(); return; }

    var el = DRAG.el;
    var mode = DRAG.mode;
    var before = DRAG.before;
    var fromIndex = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : -1;
    cleanupDrag();

    // 挪位置模式下 left/top 已经实时写好了，松手不用再补
    if (mode === "reorder" && el.parentElement) {
      el.parentElement.insertBefore(el, before ? before.el : null);
    }
    var toIndex = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : -1;
    pick(el);
    parentCall("__ctDragEnd", { mode: mode, from: fromIndex, to: toIndex,
                                id: el.getAttribute("data-ct-id") });
  });

  document.addEventListener("click", function (e) {
    var link = e.target.closest && e.target.closest("a");
    if (link) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  document.addEventListener("dragstart", function (e) { e.preventDefault(); }, true);
  document.addEventListener("submit", function (e) { e.preventDefault(); }, true);

  window.addEventListener("scroll", function () {
    drawHighlight();
    if (STATE.region) drawRegion();
  }, true);
  // 编辑态：吞掉页面自己的 click，避免点一下按钮就跳到「已加入 ✓」又变回来，看着乱也改不了
  document.addEventListener("click", function (e) {
    if (STATE.browse) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // 浏览模式：链接要点得动。站内 .html 交给编辑器切页，外链拦住（iframe 跳出去就回不来了）
  document.addEventListener("click", function (e) {
    if (!STATE.browse) return;
    var node = e.target;
    while (node && node.nodeType === 1 && node.tagName !== "A") node = node.parentElement;
    if (!node || node.tagName !== "A") return;
    var href = (node.getAttribute("href") || "").trim();
    if (!href || href.charAt(0) === "#") return;
    e.preventDefault();
    e.stopPropagation();
    var local = localHref(node);
    if (local) parentCall("__ctNav", local);
    else parentCall("__ctBlocked", href);
  }, true);

  /* ---------- 点击捕获：把「点完之后变什么样」抓下来 ----------
   * 页面里按钮点一下会改文案/颜色，过一会儿又自己变回去（JS 定时器），编辑时根本抓不住。
   * 这里在用户下一次点击时开始采样 2.6 秒：记下第一处变化和回弹时间，
   * 结果交给编辑器展示，必要时打包给 agent 去改源码里的那几行 JS。
   */

  var CAPTURE = null;

  function snapEl(el) {
    return {
      id: el.getAttribute("data-ct-id"),
      text: directText(el),
      style: el.getAttribute("style") || "",
      cls: typeof el.className === "string" ? el.className : "",
    };
  }

  function runCapture(node) {
    var before = snapEl(node);
    var info = { id: before.id, before: before, after: null, ms: -1, reverted: false, revertMs: 0 };
    var t0 = performance.now();
    var seen = false;
    function tick() {
      var now = snapEl(node);
      if (!seen && (now.text !== before.text || now.style !== before.style || now.cls !== before.cls)) {
        seen = true;
        info.after = now;
        info.ms = Math.round(performance.now() - t0);
      }
      if (seen && now.text === before.text && now.style === before.style && now.cls === before.cls) {
        info.reverted = true;
        info.revertMs = Math.round(performance.now() - t0);
      }
      var elapsed = performance.now() - t0;
      if (elapsed < 2600 && !(seen && info.reverted)) {
        setTimeout(tick, 40);
        return;
      }
      if (!seen) info.after = now;
      parentCall("__ctCaptured", info);
    }
    setTimeout(tick, 0);
  }

  function armCapture() {
    if (CAPTURE) {
      document.removeEventListener("click", CAPTURE, true);
      CAPTURE = null;
    }
    var gate = function (e) {
      var node = e.target && e.target.closest ? e.target.closest("[data-ct-id]") : null;
      if (!node || !editable(node)) return;
      document.removeEventListener("click", gate, true);
      if (CAPTURE === gate) CAPTURE = null;
      runCapture(node);
    };
    CAPTURE = gate;
    document.addEventListener("click", gate, true);
    return true;
  }

  window.addEventListener("resize", drawHighlight);

  /* ---------- 方向键：转给父窗口统一处理（焦点在哪边都生效） ---------- */

  document.addEventListener("keydown", function (e) {
    if (STATE.browse) return;
    if (!STATE.selected) return;
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    var step = e.shiftKey ? 10 : 1;
    var dx = 0;
    var dy = 0;
    if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else if (e.key === "ArrowUp") dy = -step;
    else if (e.key === "ArrowDown") dy = step;
    else return;
    e.preventDefault();
    parentCall("__ctKeyNudge", dx, dy);
  }, true);

  /* ---------- 整页一键排版 ----------
   * AI 生成的页面常见毛病：字号随手写（13/15/17/19 混着）、行高不定、内边距和 gap 是怪数、
   * 圆角五个元素五个值。这里做一次"收拢"，不重画版式：
   *   1) 先定基准字号（带文字元素里出现最多的那个），按 0.85 / 1 / 1.2 / 1.5 / 2 生成五级阶梯
   *   2) 每个带文字元素的字号就近落到阶梯上；标题行高 1.25，正文 1.5
   *   3) 内边距和 flex 的 gap 贴到 4px 网格（margin 不动：auto 居中被写死就回不去了）
   *   4) 圆角就近落到 0/4/8/12/16；超过 30 当胶囊，不碰
   * 全部走 inline（几何类本来就该 inline），一次算完一次改，撤销一下全回去。
   */

  function setInline(el, props) {
    var id = el.getAttribute("data-ct-id");
    if (!id) return;
    if (!(id in ORIG)) ORIG[id] = el.getAttribute("style") || "";
    for (var key in props) {
      if (has(props, key)) el.style[key] = props[key];
    }
  }

  function snap(value, steps) {
    var best = steps[0];
    var diff = Infinity;
    for (var i = 0; i < steps.length; i++) {
      var d = Math.abs(steps[i] - value);
      if (d < diff) { diff = d; best = steps[i]; }
    }
    return best;
  }

  function autoLayout() {
    var all = document.querySelectorAll("[data-ct-id]");
    var texts = [];
    var counts = {};
    var i;
    for (i = 0; i < all.length; i++) {
      var el = all[i];
      if (!editable(el) || !directText(el)) continue;
      var box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      texts.push(el);
      var fs = Math.round(parseFloat(getComputedStyle(el).fontSize));
      if (fs > 0) counts[fs] = (counts[fs] || 0) + 1;
    }
    if (!texts.length) return { ok: false, reason: "页面上没有找到带文字的元素" };

    var base = 0;
    var best = -1;
    for (var key in counts) {
      if (!has(counts, key)) continue;
      var size = +key;
      if (counts[key] > best ||
          (counts[key] === best && Math.abs(base - 14) > Math.abs(size - 14))) {
        base = size;
        best = counts[key];
      }
    }
    if (base < 11 || base > 22) base = 14;
    var steps = [Math.round(base * 0.85), base, Math.round(base * 1.2),
                 Math.round(base * 1.5), Math.round(base * 2)];

    var stat = { fontSize: 0, lineHeight: 0, spacing: 0, radius: 0 };
    for (i = 0; i < texts.length; i++) {
      var node = texts[i];
      var cs = getComputedStyle(node);
      var cur = parseFloat(cs.fontSize);
      if (!isFinite(cur) || cur <= 0) continue;
      var want = snap(cur, steps);
      var props = {};
      if (Math.abs(want - cur) >= 0.5) props.fontSize = want + "px";
      var tall = /^h[1-3]$/.test(node.tagName.toLowerCase());
      var ratio = tall ? 1.25 : 1.5;
      var lh = parseFloat(cs.lineHeight);
      if (!isFinite(lh) || Math.abs(lh - cur * ratio) > 1) props.lineHeight = String(ratio);
      if (Object.keys(props).length) {
        setInline(node, props);
        if (props.fontSize) stat.fontSize++;
        if (props.lineHeight) stat.lineHeight++;
      }
    }

    var sides = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
    var cssSides = ["padding-top", "padding-right", "padding-bottom", "padding-left"];
    for (i = 0; i < all.length; i++) {
      var box2 = all[i];
      if (!editable(box2)) continue;
      var rect = box2.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      var style2 = getComputedStyle(box2);
      var props2 = {};
      for (var s = 0; s < 4; s++) {
        var pad = parseFloat(style2.getPropertyValue(cssSides[s]));
        if (!isFinite(pad) || pad <= 0) continue;
        var target = Math.max(4, Math.round(pad / 4) * 4);
        if (Math.abs(target - pad) >= 1) props2[sides[s]] = target + "px";
      }
      if (/^(flex|grid)/.test(style2.display)) {
        var gap = parseFloat(style2.rowGap);
        if (isFinite(gap) && gap > 0) {
          var wantGap = Math.max(4, Math.round(gap / 4) * 4);
          if (Math.abs(wantGap - gap) >= 1) props2.gap = wantGap + "px";
        }
      }
      var radius = parseFloat(style2.borderTopLeftRadius);
      if (isFinite(radius) && radius > 0 && radius <= 30) {
        var wantR = snap(radius, [0, 4, 8, 12, 16]);
        if (Math.abs(wantR - radius) >= 1) {
          props2.borderTopLeftRadius = wantR + "px";
          props2.borderTopRightRadius = wantR + "px";
          props2.borderBottomLeftRadius = wantR + "px";
          props2.borderBottomRightRadius = wantR + "px";
        }
      }
      if (Object.keys(props2).length) {
        setInline(box2, props2);
        if (props2.gap) stat.spacing++;
        else if (props2.paddingTop || props2.paddingRight ||
                 props2.paddingBottom || props2.paddingLeft) stat.spacing++;
        if (props2.borderTopLeftRadius) stat.radius++;
      }
    }
    drawHighlight();
    return { ok: true, count: texts.length, base: base, steps: steps, stat: stat };
  }

  /* ---------- 暴露给父窗口 ---------- */

  window.__ct = {
    init: function () {
      tagIds();
      ensureHighlight();
      if (typeof window.parent.__ctPick === "function") {
        try { window.parent.__ctPick(null); } catch (_) {}
      }
      return { count: document.body.querySelectorAll("[data-ct-id]").length };
    },

    setMode: function (mode) {
      STATE.mode = mode === "offset" ? "offset" : "reorder";
      return STATE.mode;
    },

    // 圈选模式：打开后拖拽就是画框，不再选中元素
    setRegionMode: function (on) {
      STATE.regionMode = !!on;
      if (!STATE.regionMode && MARQ) {
        if (MARQ.box && MARQ.box.parentElement) MARQ.box.remove();
        MARQ = null;
      }
      return STATE.regionMode;
    },

    region: function () {
      return describeRegion();
    },

    clearRegion: function () {
      return clearRegion(false);
    },

    select: function (id) {
      var el = id ? findBy(id) : null;
      if (el) pick(el);
      else { STATE.selected = null; drawHighlight(); }
      return describe(STATE.selected);
    },

    parent: function () {
      var el = STATE.selected;
      if (!el || !el.parentElement) return null;
      pick(el.parentElement);
      return describe(STATE.selected);
    },

    // 视觉属性：写进 .pt-N / .pt-N:hover / .pt-N:active 规则；
    // 非基础态顺手把同名 inline 搬进 base 再摘掉，否则 inline 永远压过状态规则
    apply: function (id, props, state) {
      var el = findBy(id);
      if (!el) return false;
      if (!(id in ORIG)) ORIG[id] = el.getAttribute("style") || "";
      var st = state === "hover" || state === "active" ? state : "base";
      var cls = ensurePtClass(el);
      var block = document.querySelector("style[data-pt]");
      var rules = block ? parseCss(block.textContent) : [];
      var norm = {};
      var carry = {};
      for (var key in props) {
        if (!has(props, key)) continue;
        var name = kebab(key);
        norm[name] = props[key];
        if (st !== "base") {
          var base = norm[name] === "" ? "" : inlineBase(el, name);
          if (base) { carry[name] = base; dropInline(el, name); }
        } else {
          dropInline(el, name);
        }
      }
      if (Object.keys(carry).length) setDecls(rules, selOf(cls, "base"), carry);
      setDecls(rules, selOf(cls, st), norm);
      commitRules(rules);
      if (STATE.state === "hover" && STATE.selected === el) syncPreview();
      drawHighlight();
      return true;
    },

    // 几何属性：仍旧走 inline（改一次定型，不需要 hover，也不会和页面规则打架）
    applyInline: function (id, props) {
      var el = findBy(id);
      if (!el) return false;
      if (!(id in ORIG)) ORIG[id] = el.getAttribute("style") || "";
      for (var key in props) {
        if (has(props, key)) el.style[key] = props[key];
      }
      drawHighlight();
      return true;
    },

    setState: function (id, state) {
      STATE.state = state === "hover" || state === "active" ? state : "base";
      var el = id ? findBy(id) : STATE.selected;
      if (el) STATE.selected = el;
      syncPreview();
      return describe(STATE.selected);
    },

    state: function () {
      return STATE.state;
    },

    // agent 改完文件后 iframe 会重载：拍一份快照，重载完按它把滚动 / 选中 / 选区恢复回来
    snapshot: function () {
      var el = STATE.selected;
      return {
        scroll: [window.scrollX, window.scrollY],
        selected: el ? {
          id: el.getAttribute("data-ct-id"),
          tag: el.tagName.toLowerCase(),
          cls: classOf(el),
          text: directText(el).slice(0, 40),
        } : null,
        region: STATE.region,
        state: STATE.state,
      };
    },

    // 注意：下面还有一版 restore（还原整段 body 的 HTML，撤销/重做用），
    // 两个都叫 restore 会互相覆盖，所以恢复快照这个叫 restoreSnap
    restoreSnap: function (snap) {
      if (!snap) return false;
      var sc = snap.scroll || [0, 0];
      window.scrollTo(sc[0], sc[1]);
      if (snap.region) {
        STATE.region = snap.region;
        STATE.regionEls = hitRegion(snap.region);
        drawRegion();
        parentCall("__ctRegionChange");
      }
      var el = snap.selected ? findLike(snap.selected) : null;
      STATE.selected = el;
      if (el) {
        pick(el);
      } else {
        drawHighlight();
        parentCall("__ctPick", null);
      }
      return !!el;
    },

    // 浏览模式：不选中、不拖拽、不画框，点按钮就是真的点；
    // 原来选中的元素记着，退出浏览后原位恢复（蓝框回来）
    setBrowse: function (on) {
      STATE.browse = !!on;
      if (STATE.browse) {
        STATE.regionMode = false;
        if (MARQ) {
          if (MARQ.box && MARQ.box.parentElement) MARQ.box.remove();
          MARQ = null;
        }
        DRAG = null;
      }
      drawHighlight();
      return STATE.browse;
    },

    browse: function () {
      return STATE.browse;
    },

    // 等用户点一下，记录点击前后的变化（文案/样式/类名）和回弹时间
    capture: armCapture,

    // 整页一键排版（字号阶梯 / 行高 / 4px 间距网格 / 圆角取整），调用前由编辑器拍撤销快照
    autoLayout: autoLayout,

    // 正在拖拽/画框时不要重载，否则会把人的操作打断
    busy: function () {
      return !!(DRAG || MARQ);
    },

    reset: function (id) {
      var el = findBy(id);
      if (!el) return false;
      var cls = ptClass(el);
      if (cls) {
        el.classList.remove(cls);
        el.classList.remove("pt-preview");
        var block = document.querySelector("style[data-pt]");
        if (block) {
          var re = new RegExp("^\\." + cls + "(\\." + cls + ")?(:hover)?$");
          commitRules(parseCss(block.textContent).filter(function (r) { return !re.test(r.sel); }));
        }
      }
      if (id in ORIG) {
        if (ORIG[id]) el.setAttribute("style", ORIG[id]);
        else el.removeAttribute("style");
      }
      drawHighlight();
      return true;
    },

    // 删除元素（编辑器侧手删，撤销靠 bodyHtml 快照；agent 侧对应 html_delete）
    remove: function (id) {
      var el = findBy(id);
      if (!el || el.tagName === "BODY" || el.tagName === "HTML") return false;
      el.remove();
      if (STATE.selected === el) {
        STATE.selected = null;
        drawHighlight();
        if (typeof window.parent.__ctPick === "function") {
          try { window.parent.__ctPick(null); } catch (_) {}
        }
      }
      return true;
    },

    // 只动直接文本节点。有子元素时绝不能回退到 textContent，否则整个子层级会被一串文字替换掉
    setText: function (id, text) {
      var el = findBy(id);
      if (!el) return false;
      var nodes = [];
      for (var i = 0; i < el.childNodes.length; i++) {
        var node = el.childNodes[i];
        if (node.nodeType === 3 && node.textContent.trim()) nodes.push(node);
      }
      if (!nodes.length) {
        if (el.children.length) return false;
        el.textContent = text;
      } else {
        nodes[0].textContent = text;
        // 其余文本节点清空，否则会剩下半截旧标题
        for (var k = 1; k < nodes.length; k++) nodes[k].textContent = "";
      }
      drawHighlight();
      return true;
    },

    move: function (id, dir) {
      var el = findBy(id);
      if (!el || !el.parentElement) return false;
      var sib = dir === "up" ? el.previousElementSibling : el.nextElementSibling;
      if (!sib) return false;
      if (dir === "up") el.parentElement.insertBefore(el, sib);
      else el.parentElement.insertBefore(sib, el);
      drawHighlight();
      return true;
    },

    bodyHtml: function () {
      var clone = document.body.cloneNode(true);
      var junk = clone.querySelectorAll('[data-ct-internal="1"], #ct-inject');
      for (var i = 0; i < junk.length; i++) junk[i].remove();
      // pt-preview 只是编辑时的预演标记，不能跟着快照/导出文件走
      var prev = clone.querySelectorAll(".pt-preview");
      for (var k = 0; k < prev.length; k++) prev[k].classList.remove("pt-preview");
      return clone.innerHTML;
    },

    wholeHtml: function () {
      var clone = document.documentElement.cloneNode(true);
      var junk = clone.querySelectorAll('[data-ct-internal="1"], #ct-inject');
      for (var i = 0; i < junk.length; i++) junk[i].remove();
      var prev = clone.querySelectorAll(".pt-preview");
      for (var k = 0; k < prev.length; k++) prev[k].classList.remove("pt-preview");
      // 用精修器改精修器自己时，预览里那个 iframe 会被临时换成 about:blank 防递归；
      // 保存/导出前把它还原成原来的 src，否则存回去就把编辑器拆了
      var paused = clone.querySelectorAll("[data-ct-iframe]");
      for (var p = 0; p < paused.length; p++) {
        paused[p].setAttribute("src", paused[p].getAttribute("data-ct-iframe") || "/preview");
        paused[p].removeAttribute("data-ct-iframe");
      }
      // 导出物要能直接交付，编辑器的内部编号不能跟着走（撤销快照用的是 bodyHtml，不在这里剔）
      var tagged = clone.querySelectorAll("[data-ct-id]");
      for (var j = 0; j < tagged.length; j++) tagged[j].removeAttribute("data-ct-id");
      return "<!DOCTYPE html>\n" + clone.outerHTML;
    },

    restore: function (html) {
      document.body.innerHTML = html;
      ORIG = {};
      ZERO = {};
      tagIds();
      ensureHighlight();
      STATE.selected = null;
      drawHighlight();
    },

    offset: function (id) {
      var el = findBy(id);
      if (!el) return null;
      var cs = getComputedStyle(el);
      return {
        left: parseFloat(cs.left) || 0,
        top: parseFloat(cs.top) || 0,
        position: cs.position,
      };
    },

    setOffset: function (id, left, top) {
      var el = findBy(id);
      if (!el) return false;
      var cs = getComputedStyle(el);
      if (cs.position === "static") {
        ZERO[id] = true;
        el.style.position = "relative";
      }
      el.style.left = left + "px";
      el.style.top = top + "px";
      drawHighlight();
      return true;
    },

    zeroOffset: function (id) {
      var el = findBy(id);
      if (!el) return false;
      el.style.left = "";
      el.style.top = "";
      if (ZERO[id]) { el.style.position = ""; delete ZERO[id]; }
      drawHighlight();
      return true;
    },

    rect: function () {
      var el = STATE.selected;
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    },
  };

  window.__ct.init();
})();
