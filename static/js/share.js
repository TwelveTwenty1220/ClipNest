/* ClipNest 公开分享只读页。
 *
 * 免登录：只调 GET /api/public/<token>。
 * 所有分享内容一律 textContent 写入 —— 这是别人给的数据，绝不能碰 innerHTML。
 */

import { api, ApiError } from "./api.js";

/* 与主应用同一个可选预览插件；没装就只是没有预览。 */
const previewPlugin = await import("./preview.js?v=1").catch(() => null);
const contentPreview = previewPlugin?.contentPreview ?? (() => null);

const LS_THEME = "clipnest_theme";
const COPIED_MS = 1500;
const DEFAULT_TITLE = "未命名";

/* ── 图标（写死的静态片段） ── */
const ICONS = {
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 16h.01"/>',
  folder:
    '<path d="M3 8a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.5 8H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M2.5 12h2M19.5 12h2M5.4 18.6l1.4-1.4M17.2 6.8l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  link: '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 1 0-5.7-5.7l-1 1"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 1 0 5.7 5.7l1-1"/>',
};

function icon(name, size = 16, strokeWidth = 1.8) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(strokeWidth));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name] || "";
  return svg;
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function absTime(ts) {
  if (!ts && ts !== 0) return "";
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

/* ── 复制（与主应用同一套降级策略） ── */

async function copyText(text) {
  const value = text ?? "";
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) {
    /* 落到降级路径 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.setAttribute("aria-hidden", "true");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.width = "1px";
    ta.style.height = "1px";
    ta.style.opacity = "0";
    ta.style.border = "none";
    ta.style.padding = "0";
    document.body.appendChild(ta);
    const active = document.activeElement;
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (active && typeof active.focus === "function") active.focus();
    return ok;
  } catch (_) {
    return false;
  }
}

function toast(message, kind = "info") {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const node = h("div", `toast toast-${kind}`);
  if (kind === "error") node.appendChild(icon("alert", 15));
  node.appendChild(h("span", null, message));
  root.appendChild(node);
  window.setTimeout(() => {
    node.classList.add("is-out");
    window.setTimeout(() => node.remove(), 200);
  }, 2600);
}

function copyButton(getText, { large = false, label = "一键复制" } = {}) {
  const btn = h("button", `copy-btn${large ? " copy-btn-lg" : ""}`);
  btn.type = "button";
  btn.setAttribute("aria-label", label);
  const paintIdle = () => {
    clear(btn);
    btn.appendChild(icon("copy", large ? 16 : 14, 2));
    btn.appendChild(h("span", null, label));
  };
  paintIdle();
  btn.addEventListener("click", async () => {
    const ok = await copyText(getText());
    if (!ok) {
      toast("复制失败，请手动选中内容复制", "error");
      return;
    }
    if (btn.dataset.flashing === "1") return;
    btn.dataset.flashing = "1";
    clear(btn);
    btn.appendChild(icon("check", large ? 16 : 14, 2.4));
    btn.appendChild(h("span", null, "已复制"));
    btn.classList.add("is-copied");
    window.setTimeout(() => {
      btn.classList.remove("is-copied");
      delete btn.dataset.flashing;
      paintIdle();
    }, COPIED_MS);
  });
  return btn;
}

/* ── 主题（与主应用共用 localStorage key） ── */

function readTheme() {
  try {
    const v = localStorage.getItem(LS_THEME);
    return v === "dark" || v === "light" ? v : "system";
  } catch (_) {
    return "system";
  }
}

function applyTheme(mode, btn) {
  const root = document.documentElement;
  if (mode === "dark" || mode === "light") root.setAttribute("data-theme", mode);
  else root.removeAttribute("data-theme");
  try {
    if (mode === "system") localStorage.removeItem(LS_THEME);
    else localStorage.setItem(LS_THEME, mode);
  } catch (_) {}
  const map = {
    system: ["monitor", "主题：跟随系统"],
    light: ["sun", "主题：浅色"],
    dark: ["moon", "主题：深色"],
  };
  const [name, label] = map[mode] || map.system;
  clear(btn);
  btn.appendChild(icon(name, 17));
  btn.setAttribute("aria-label", `${label}（点击切换）`);
  btn.title = `${label}（点击切换）`;
}

function mountThemeToggle() {
  const top = document.querySelector(".share-top");
  if (!top) return;
  const btn = h("button", "icon-btn");
  btn.type = "button";
  const order = ["system", "light", "dark"];
  applyTheme(readTheme(), btn);
  btn.addEventListener("click", () => {
    const next = order[(order.indexOf(readTheme()) + 1) % order.length];
    applyTheme(next, btn);
  });
  const by = top.querySelector(".share-by");
  if (by) top.insertBefore(btn, by.nextSibling);
  else top.appendChild(btn);
}

/* ── 渲染 ── */

const main = document.getElementById("share-main");

function renderState(title, text) {
  clear(main);
  const box = h("div", "state-page");
  box.appendChild(icon("alert", 32, 1.4));
  box.appendChild(h("h1", "state-title", title));
  box.appendChild(h("p", "state-text", text));
  const home = h("a", "btn", "去 ClipNest 首页");
  home.href = "/";
  box.appendChild(home);
  main.appendChild(box);
}

function renderItemPayload(payload, meta) {
  const item = payload.item || {};
  const title = item.title || DEFAULT_TITLE;
  document.title = `${title} · ClipNest 分享`;

  clear(main);
  main.classList.add("is-solo");
  const head = h("div", "share-head");
  head.appendChild(h("h1", "share-title", title));
  head.appendChild(copyButton(() => item.content ?? "", { large: true }));
  main.appendChild(head);
  main.appendChild(meta);

  // 与应用内卡片一致的左右布局：预览在左，内容在右
  const row = h("div", "share-solo");
  const preview = contentPreview(item.content ?? "");
  if (preview) row.appendChild(preview);
  const pre = h("pre", "share-content");
  pre.textContent = item.content ?? "";
  row.appendChild(pre);
  main.appendChild(row);
}

/* 分享的目录快照。渲染成「左树右卡片」，和登录后看自己的库是同一套操作方式：
   点左边切换文件夹，右边只换内容，树本身不跟着滚走。 */
const snap = {
  name: "",
  items: [],
  byParent: new Map(),
  byId: new Map(),
  expanded: new Set(),
  current: null, // 当前选中的文件夹 id，null = 分享根
};

const childFolders = (id) => snap.byParent.get(id ?? null) || [];

/** 含自身的子树 id 集合。 */
function subtreeIds(id) {
  const out = new Set([id ?? null]);
  const stack = [id ?? null];
  while (stack.length) {
    for (const child of childFolders(stack.pop())) {
      if (out.has(child.id)) continue; // 快照理论上无环，真坏了也不能死循环
      out.add(child.id);
      stack.push(child.id);
    }
  }
  return out;
}

const itemsOf = (id) => snap.items.filter((it) => (it.folder_id ?? null) === (id ?? null));

function itemsInSubtree(id) {
  const ids = subtreeIds(id);
  return snap.items.filter((it) => ids.has(it.folder_id ?? null));
}

/** 从分享根算起的完整路径，用作标题。 */
function folderLabel(id) {
  const parts = [];
  let node = id == null ? null : snap.byId.get(id);
  while (node) {
    parts.unshift(node.name ?? "");
    node = node.parent_id == null ? null : snap.byId.get(node.parent_id);
  }
  return [snap.name, ...parts].join(" / ");
}

function renderFolderPayload(payload, meta) {
  const name = payload.name || "未命名文件夹";
  const items = Array.isArray(payload.items) ? payload.items : [];
  const folders = Array.isArray(payload.folders) ? payload.folders : [];
  document.title = `${name} · ClipNest 分享`;

  const known = new Set(folders.map((f) => f.id));
  snap.name = name;
  snap.items = items;
  snap.byId = new Map(folders.map((f) => [f.id, f]));
  snap.byParent = new Map();
  folders.forEach((f) => {
    // 父引用断链的挂到根下，别让整个子树消失
    const parent = known.has(f.parent_id) ? f.parent_id : null;
    f.parent_id = parent;
    if (!snap.byParent.has(parent)) snap.byParent.set(parent, []);
    snap.byParent.get(parent).push(f);
  });
  snap.byParent.forEach((list) =>
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) ||
      String(a.name).localeCompare(String(b.name), "zh-Hans-CN"))
  );
  // 分享快照都不大，默认全展开：点开就能直接跳，省一次点击
  snap.expanded = new Set(folders.map((f) => f.id));
  snap.current = null;
  snap.meta = meta;

  main.classList.remove("is-solo");
  // 只有一层的分享没什么可切的，不占那 260px
  if (folders.length) {
    document.getElementById("share-page")?.classList.add("has-side");
    renderSide();
  }
  renderMain();
}

/* ── 左侧目录树 ── */

function sideRow({ iconName, label, count, active, depth = 0, twisty, onClick }) {
  const row = h("div", `nav-item${active ? " is-active" : ""}${depth ? " tree-row" : ""}`);
  if (depth) row.style.setProperty("--depth", String(depth));
  if (twisty) {
    const tw = h("button", `twisty${twisty.open ? " is-open" : ""}${twisty.leaf ? " is-leaf" : ""}`);
    tw.type = "button";
    tw.tabIndex = twisty.leaf ? -1 : 0;
    tw.setAttribute("aria-label", twisty.open ? "折叠" : "展开");
    tw.appendChild(icon("chevronRight", 12, 2.2));
    tw.addEventListener("click", (ev) => {
      ev.stopPropagation();
      twisty.onToggle();
    });
    row.appendChild(tw);
  }
  const btn = h("button", "nav-main");
  btn.type = "button";
  if (active) btn.setAttribute("aria-current", "true");
  const ic = icon(iconName, 15);
  ic.classList.add("nav-icon");
  btn.appendChild(ic);
  btn.appendChild(h("span", "nav-label", label));
  if (count > 0) btn.appendChild(h("span", "nav-count", String(count)));
  btn.addEventListener("click", onClick);
  row.appendChild(btn);
  return row;
}

function renderSide() {
  const side = document.getElementById("share-side");
  if (!side) return;
  clear(side);
  side.hidden = false;

  const scroll = h("div", "sidebar-scroll");
  scroll.appendChild(
    sideRow({
      iconName: "grid",
      label: snap.name,
      count: snap.items.length,
      active: snap.current === null,
      onClick: () => select(null),
    })
  );

  const section = h("div", "sidebar-section");
  const heading = h("div", "sidebar-heading");
  heading.appendChild(h("span", null, "子文件夹"));
  heading.appendChild(h("span", null, String(snap.byId.size)));
  section.appendChild(heading);
  childFolders(null).forEach((f) => appendFolderRows(section, f, 0));
  scroll.appendChild(section);

  side.appendChild(scroll);
}

function appendFolderRows(container, folder, depth) {
  const kids = childFolders(folder.id);
  const open = snap.expanded.has(folder.id);
  container.appendChild(
    sideRow({
      iconName: "folder",
      label: folder.name ?? "",
      // 和应用内一致：算上子文件夹，折叠时才不会显得内容凭空少了
      count: itemsInSubtree(folder.id).length,
      active: snap.current === folder.id,
      depth,
      twisty: {
        open,
        leaf: kids.length === 0,
        onToggle: () => {
          if (open) snap.expanded.delete(folder.id);
          else snap.expanded.add(folder.id);
          renderSide();
        },
      },
      onClick: () => select(folder.id),
    })
  );
  if (open) kids.forEach((kid) => appendFolderRows(container, kid, depth + 1));
}

function select(folderId) {
  if (snap.current === folderId) return;
  snap.current = folderId;
  renderSide();
  renderMain();
  main.scrollTop = 0;
  // 窄屏下滚动条在页面上，光复位 main 没用，得把内容区带回视野
  if (window.matchMedia("(max-width: 860px)").matches) {
    main.scrollIntoView({ block: "start" });
  }
}

/* ── 右侧内容 ── */

function renderMain() {
  const scope = itemsInSubtree(snap.current);
  const label = folderLabel(snap.current);

  clear(main);
  const head = h("div", "share-head");
  const titleBox = h("div");
  titleBox.style.flex = "1";
  titleBox.style.minWidth = "0";
  titleBox.appendChild(h("h1", "share-title", label));
  const subs = childFolders(snap.current).length;
  titleBox.appendChild(
    h("p", "state-text", subs ? `共 ${scope.length} 条内容 · ${subs} 个子文件夹` : `共 ${scope.length} 条内容`)
  );
  head.appendChild(titleBox);
  if (scope.length) {
    head.appendChild(
      copyButton(() => scope.map((it) => it.content ?? "").join("\n\n"), {
        large: true,
        label: "复制全部",
      })
    );
  }
  main.appendChild(head);
  if (snap.meta) main.appendChild(snap.meta);

  if (!scope.length) {
    const box = h("div", "empty");
    box.appendChild(h("p", "empty-title", "这个文件夹是空的"));
    main.appendChild(box);
    return;
  }

  // 视图内仍按层级分组：选了父目录时，子目录的内容不该摊成一锅
  let index = 0;
  const walk = (folderId, path, depth) => {
    const own = itemsOf(folderId);
    if (own.length) main.appendChild(groupSection(path, own, depth, () => index++));
    childFolders(folderId).forEach((child) =>
      walk(child.id, `${path} / ${child.name ?? ""}`, depth + 1)
    );
  };
  // 分组标题只写相对当前视图的路径 —— 完整路径标题栏已经有了，重复一遍太占地方
  walk(snap.current, snap.current == null ? snap.name : snap.byId.get(snap.current)?.name ?? "", 0);
}

/** 一个分组：标题 + 该层直属条目的卡片网格。 */
function groupSection(label, list, depth, nextIndex) {
  const section = h("section", "share-group");
  if (depth) section.style.setProperty("--depth", String(Math.min(depth, 4)));

  const head = h("div", "share-group-head");
  const title = h("h2", "share-group-title");
  title.appendChild(icon("folder", 14, 2));
  title.appendChild(h("span", null, label));
  head.appendChild(title);
  head.appendChild(h("span", "share-group-count", `${list.length} 条`));
  head.appendChild(
    copyButton(() => list.map((it) => it.content ?? "").join("\n\n"), { label: "复制本组" })
  );
  section.appendChild(head);

  const grid = h("div", "grid");
  list.forEach((item) => {
    const i = nextIndex();
    const card = h("article", "card");
    // 入场动画只给首屏几张，几百张一起动会让滚动发闷
    if (i < 18) card.style.animationDelay = `${i * 18}ms`;
    else card.style.animation = "none";

    const ch = h("div", "card-head");
    ch.appendChild(h("h3", "card-title", item.title || DEFAULT_TITLE));
    ch.appendChild(copyButton(() => item.content ?? "", { label: "复制" }));
    card.appendChild(ch);

    const media = h("div", "card-media");
    const preview = contentPreview(item.content ?? "");
    if (preview) media.appendChild(preview);
    const body = h("div", "card-body");
    const bodyText = h("div", "card-body-text");
    bodyText.textContent = item.content ?? "";
    body.appendChild(bodyText);
    media.appendChild(body);
    card.appendChild(media);

    grid.appendChild(card);
  });
  section.appendChild(grid);
  return section;
}

function buildMeta(data) {
  const meta = h("p", "meta");
  meta.style.marginBottom = "var(--s-5)";
  const parts = [];
  if (data.created_at) parts.push(`分享于 ${absTime(data.created_at)}`);
  parts.push(data.expires_at ? `${absTime(data.expires_at)} 过期` : "永久有效");
  meta.textContent = parts.join(" · ");
  return meta;
}

async function load() {
  const page = document.getElementById("share-page");
  const token = page?.dataset.token || "";
  if (!token) {
    renderState("链接不存在或已过期", "请向分享者确认链接是否正确。");
    return;
  }
  try {
    const data = await api.getPublic(token);
    const payload = data?.payload;
    if (!payload) {
      renderState("这条分享是空的", "分享者可能撤销了内容，请向他确认。");
      return;
    }
    const meta = buildMeta(data);
    if (payload.kind === "folder") renderFolderPayload(payload, meta);
    else renderItemPayload(payload, meta);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      renderState("链接不存在或已过期", "这个分享可能已被撤销、已过期，或链接输入有误。");
    } else if (err instanceof ApiError) {
      renderState("打不开这条分享", err.message || "请稍后重试。");
    } else {
      renderState("网络连接失败", "请检查网络后刷新页面重试。");
    }
  }
}

mountThemeToggle();
load();
