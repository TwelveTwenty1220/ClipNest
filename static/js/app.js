/* ClipNest 主应用逻辑。
 *
 * 设计要点：
 *   - 单一 state + 全量重渲染。数据量上限只有 2000 条，重渲染比增量 diff 更不容易出错。
 *   - 所有来自接口的文本一律 textContent / createElement 写入，绝不 innerHTML（XSS）。
 *     innerHTML 只用于本文件内写死的图标路径常量。
 *   - 轮询只在 changed === true 时重渲染，避免每 4 秒打断用户的悬停与焦点。
 */

import {
  api,
  ApiError,
  NetworkError,
  getToken,
  setToken,
  clearToken,
  setUnauthorizedHandler,
} from "./api.js";

/* 可选的内容预览插件。装了就用，没装就只是没有预览 —— 它不随仓库分发，
 * 所以这里必须容错，不能让整个应用因为少一个文件就挂掉。
 * 插件自己决定什么内容值得预览、以及往哪个目录下才生效。 */
// 带版本号是为了绕开可能被缓存的 404：插件文件上线前的空窗期若被请求过一次，
// 浏览器会把那次 404 连同当时的强缓存头一起存下来，之后几小时都不再回源。
const previewPlugin = await import("./preview.js?v=1").catch(() => null);
const contentPreview = previewPlugin?.contentPreview ?? (() => null);

/* ══════════════════════════════════════════════════
   常量
   ══════════════════════════════════════════════════ */

const LS_THEME = "clipnest_theme";
const LS_EXPANDED = "clipnest_expanded";
const LS_VIEW = "clipnest_view";

const POLL_MS = 4000;
const COPIED_MS = 1500;
const MAX_TITLE_LEN = 200;
const MAX_FOLDER_NAME = 60;
const MAX_CONTENT_LEN = 100000;
const MIN_PASSWORD = 8;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;
const DEFAULT_TITLE = "未命名";
const MAX_DEPTH_GUARD = 32; // 防御性：接口数据若成环，不至于死循环

/* ══════════════════════════════════════════════════
   图标（写死的静态 SVG 片段，不含任何接口数据）
   ══════════════════════════════════════════════════ */

const ICONS = {
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  folder:
    '<path d="M3 8a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.5 8H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderPlus:
    '<path d="M3 8a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.5 8H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>',
  inbox:
    '<path d="M21 12h-5l-2 3h-4l-2-3H3"/><path d="M6.4 5.3 3 12v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6l-3.4-6.7A2 2 0 0 0 15.8 4H8.2a2 2 0 0 0-1.8 1.3z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
  pencil:
    '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M13.5 6.5 17 10"/>',
  pin: '<path d="M9 4h6l-1 5.5 3 3V15H7v-2.5l3-3z"/><path d="M12 15v5"/>',
  share:
    '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4"/>',
  trash:
    '<path d="M4 7h16"/><path d="M10 4h4"/><path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7"/><path d="M10 11v6M14 11v6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M2.5 12h2M19.5 12h2M5.4 18.6l1.4-1.4M17.2 6.8l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  logout:
    '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  link: '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 1 0-5.7-5.7l-1 1"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 1 0 5.7 5.7l1-1"/>',
  users:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2a3.5 3.5 0 0 1 0 5.6M17.5 20a6.6 6.6 0 0 0-2-4.7"/>',
  shield:
    '<path d="M12 3 5 6v5.5c0 4.2 2.9 8.1 7 9.5 4.1-1.4 7-5.3 7-9.5V6z"/><path d="m9.5 12 1.8 1.8 3.4-3.6"/>',
  save: '<path d="M12 3v11"/><path d="m8 11 4 4 4-4"/><path d="M4.5 17v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/>',
  undo: '<path d="M9 7 5 11l4 4"/><path d="M5 11h9a5 5 0 0 1 5 5v2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 16h.01"/>',
  box: '<path d="M3 8.5 12 4l9 4.5-9 4.5z"/><path d="M3 8.5V16l9 4.5 9-4.5V8.5"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  file: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
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

/* ══════════════════════════════════════════════════
   DOM 小工具
   ══════════════════════════════════════════════════ */

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function iconButton(name, label, { className = "icon-btn", size = 16 } = {}) {
  const btn = h("button", className);
  btn.type = "button";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.appendChild(icon(name, size));
  return btn;
}

function labeledButton(iconName, text, className = "btn btn-sm") {
  const btn = h("button", className);
  btn.type = "button";
  if (iconName) btn.appendChild(icon(iconName, 14));
  btn.appendChild(h("span", null, text));
  return btn;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/* ══════════════════════════════════════════════════
   时间格式化
   ══════════════════════════════════════════════════ */

function relTime(ts) {
  if (!ts && ts !== 0) return "";
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 0) return "刚刚";
  if (diff < 45) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return absTime(ts, false);
}

function absTime(ts, withTime = true) {
  if (!ts && ts !== 0) return "";
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}

function humanDuration(sec) {
  if (sec === null || sec === undefined) return "永久";
  if (sec <= 0) return "已过期";
  if (sec < 3600) return `${Math.ceil(sec / 60)} 分钟`;
  if (sec < 86400) return `${Math.round(sec / 3600)} 小时`;
  return `${Math.round(sec / 86400)} 天`;
}

/* ══════════════════════════════════════════════════
   复制（含降级路径）
   ══════════════════════════════════════════════════ */

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
  // 降级：真实存在于文档流中的只读 textarea + execCommand
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
    ta.style.padding = "0";
    ta.style.border = "none";
    ta.style.opacity = "0";
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

/** 复制按钮的成功反馈：短暂变绿并显示「已复制」。 */
function flashCopied(btn, label = "已复制") {
  if (btn.dataset.flashing === "1") return;
  btn.dataset.flashing = "1";
  const snapshot = Array.from(btn.childNodes);
  clear(btn);
  btn.appendChild(icon("check", 14, 2.4));
  btn.appendChild(h("span", null, label));
  btn.classList.add("is-copied");
  window.setTimeout(() => {
    clear(btn);
    snapshot.forEach((n) => btn.appendChild(n));
    btn.classList.remove("is-copied");
    delete btn.dataset.flashing;
  }, COPIED_MS);
}

async function copyAndFlash(btn, text, label = "已复制") {
  const ok = await copyText(text);
  if (ok) flashCopied(btn, label);
  else toast("复制失败，请手动选中内容复制", "error");
}

/* ══════════════════════════════════════════════════
   Toast
   ══════════════════════════════════════════════════ */

function toast(message, kind = "info") {
  const root = $("#toast-root");
  if (!root) return;
  const node = h("div", `toast toast-${kind}`);
  if (kind === "success") node.appendChild(icon("check", 15, 2.2));
  else if (kind === "error") node.appendChild(icon("alert", 15));
  node.appendChild(h("span", null, message));
  root.appendChild(node);
  window.setTimeout(() => {
    node.classList.add("is-out");
    window.setTimeout(() => node.remove(), 200);
  }, kind === "error" ? 3600 : 2200);
}

/** 把接口异常转成一句人话（后端 message 已是中文，优先用它）。 */
function errMessage(err) {
  if (err instanceof NetworkError) return "网络连接失败，请检查网络后重试";
  if (err instanceof ApiError) return err.message || "操作失败";
  return err?.message || "操作失败";
}

function reportError(err) {
  // 401 已由 api 层统一处理（清 token + 切登录页），无需再弹提示
  if (err instanceof ApiError && err.status === 401) return;
  toast(errMessage(err), "error");
}

/* ══════════════════════════════════════════════════
   主题
   ══════════════════════════════════════════════════ */

function readTheme() {
  try {
    const v = localStorage.getItem(LS_THEME);
    return v === "dark" || v === "light" ? v : "system";
  } catch (_) {
    return "system";
  }
}

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "dark" || mode === "light") root.setAttribute("data-theme", mode);
  else root.removeAttribute("data-theme");
  try {
    if (mode === "system") localStorage.removeItem(LS_THEME);
    else localStorage.setItem(LS_THEME, mode);
  } catch (_) {
    /* 存不下也不影响本次会话 */
  }
  paintThemeButton(mode);
}

function paintThemeButton(mode) {
  const btn = $("#theme-btn");
  if (!btn) return;
  const map = {
    system: ["monitor", "主题：跟随系统（点击切换为浅色）"],
    light: ["sun", "主题：浅色（点击切换为深色）"],
    dark: ["moon", "主题：深色（点击切换为跟随系统）"],
  };
  const [name, label] = map[mode] || map.system;
  clear(btn);
  btn.appendChild(icon(name, 17));
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

function cycleTheme() {
  const order = ["system", "light", "dark"];
  const next = order[(order.indexOf(readTheme()) + 1) % order.length];
  applyTheme(next);
}

/* ══════════════════════════════════════════════════
   全局状态
   ══════════════════════════════════════════════════ */

const state = {
  user: null,
  rev: -1,
  folders: [],
  items: [],
  inboxCount: 0,
  view: { type: "all" },
  query: "", // 顶栏的全局搜索
  folderQuery: "", // 文件夹页内的就地搜索，换文件夹即清空
  selection: new Set(), // 批量选中的条目 id
  expanded: loadExpanded(),
  offline: false,
  dragItemId: null,
  // 惰性加载的次级数据
  inbox: null,
  outbox: null,
  links: null,
  admin: { invite: null, settings: null, users: null, loading: false },
};

function loadExpanded() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_EXPANDED) || "[]");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch (_) {
    return new Set();
  }
}

function saveExpanded() {
  try {
    localStorage.setItem(LS_EXPANDED, JSON.stringify(Array.from(state.expanded)));
  } catch (_) {}
}

function saveView() {
  try {
    localStorage.setItem(LS_VIEW, JSON.stringify(state.view));
  } catch (_) {}
}

function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_VIEW) || "null");
    if (v && typeof v.type === "string") return v;
  } catch (_) {}
  return { type: "all" };
}

/* ── 派生数据 ── */

const folderById = (id) => state.folders.find((f) => f.id === id) || null;

function childFolders(parentId) {
  return state.folders
    .filter((f) => (f.parent_id ?? null) === (parentId ?? null))
    .sort(
      (a, b) =>
        (a.order ?? 0) - (b.order ?? 0) ||
        (a.created_at ?? 0) - (b.created_at ?? 0) ||
        String(a.name).localeCompare(String(b.name), "zh-Hans-CN")
    );
}

function folderPath(id) {
  const path = [];
  let cur = folderById(id);
  let guard = 0;
  while (cur && guard++ < MAX_DEPTH_GUARD) {
    path.unshift(cur);
    cur = cur.parent_id ? folderById(cur.parent_id) : null;
  }
  return path;
}

function folderLabel(id) {
  const p = folderPath(id);
  return p.length ? p.map((f) => f.name).join(" / ") : "根目录";
}

/** 只要最后一级。卡片上的标签空间有限，"项目 / 配置 / 生产 / 数据库"
 *  截断后剩下的恰恰是最没用的前几级，真正想知道的"是哪个分类"反而被切掉了。
 *  完整路径放到 title 里，鼠标悬停可见。 */
function folderLeaf(id) {
  return folderById(id)?.name ?? "根目录";
}

/** 文件夹自身及全部后代的 id 集合。 */
function subtreeIds(id) {
  const out = new Set([id]);
  let frontier = [id];
  let guard = 0;
  while (frontier.length && guard++ < MAX_DEPTH_GUARD) {
    const next = [];
    for (const fid of frontier) {
      for (const child of state.folders) {
        if ((child.parent_id ?? null) === fid && !out.has(child.id)) {
          out.add(child.id);
          next.push(child.id);
        }
      }
    }
    frontier = next;
  }
  return out;
}

function sortItems(list) {
  return list.slice().sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    return (b.updated_at ?? 0) - (a.updated_at ?? 0);
  });
}

function itemsOfFolder(folderId) {
  return sortItems(
    state.items.filter((it) => (it.folder_id ?? null) === (folderId ?? null))
  );
}

/** 文件夹及其全部子文件夹里的条目。
 *
 * 侧栏计数、文件夹视图、按文件夹搜索都用这个 —— 三处必须是同一个口径，
 * 否则会出现"侧栏标着 123、点进去显示 0 条"这种自相矛盾的情况。 */
function itemsInSubtree(folderId) {
  if (folderId == null) return sortItems(state.items);
  const ids = subtreeIds(folderId);
  return sortItems(state.items.filter((it) => ids.has(it.folder_id ?? null)));
}

function matchesQuery(item, q) {
  return (
    String(item.title ?? "").toLowerCase().includes(q) ||
    String(item.content ?? "").toLowerCase().includes(q)
  );
}

/** 顶栏搜索：始终跨全部文件夹。文件夹内的就地搜索见 renderItems。 */
function searchItems(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return sortItems(state.items.filter((it) => matchesQuery(it, q)));
}

/* ══════════════════════════════════════════════════
   模态框（焦点管理 + Esc + 焦点归还）
   ══════════════════════════════════════════════════ */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const modalStack = [];

function openModal({
  title,
  size = "",
  build,
  footer,
  initialFocus,
  onClose,
  flush = false,
}) {
  const previousFocus = document.activeElement;
  const scrim = h("div", "scrim");
  const modal = h("div", `modal ${size}`.trim());
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;
  const head = h("div", "modal-head");
  const titleNode = h("h2", "modal-title", title);
  titleNode.id = titleId;
  modal.setAttribute("aria-labelledby", titleId);
  head.appendChild(titleNode);
  const closeBtn = iconButton("x", "关闭");
  head.appendChild(closeBtn);
  modal.appendChild(head);

  const body = h("div", `modal-body${flush ? " is-flush" : ""}`);
  modal.appendChild(body);

  let footNode = null;
  if (footer) {
    footNode = h("div", "modal-foot");
    modal.appendChild(footNode);
  }

  scrim.appendChild(modal);

  const ctx = { scrim, modal, body, foot: footNode, close };
  if (build) build(ctx);
  if (footer) footer(ctx);

  function onKeyDown(ev) {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
      return;
    }
    if (ev.key !== "Tab") return;
    // 焦点环：Tab 在模态内循环
    const nodes = Array.from(modal.querySelectorAll(FOCUSABLE)).filter(
      (n) => n.offsetParent !== null || n === document.activeElement
    );
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  function close() {
    if (!scrim.isConnected) return;
    modal.removeEventListener("keydown", onKeyDown);
    scrim.remove();
    const idx = modalStack.indexOf(ctx);
    if (idx >= 0) modalStack.splice(idx, 1);
    if (!modalStack.length) document.body.style.removeProperty("overflow");
    if (previousFocus && typeof previousFocus.focus === "function") {
      previousFocus.focus();
    }
    if (onClose) onClose();
  }

  closeBtn.addEventListener("click", close);
  scrim.addEventListener("mousedown", (ev) => {
    if (ev.target === scrim) close();
  });
  modal.addEventListener("keydown", onKeyDown);

  $("#modal-root").appendChild(scrim);
  modalStack.push(ctx);
  document.body.style.overflow = "hidden";

  const focusTarget =
    (typeof initialFocus === "function" ? initialFocus(ctx) : initialFocus) ||
    modal.querySelector(FOCUSABLE);
  if (focusTarget && typeof focusTarget.focus === "function") {
    window.setTimeout(() => focusTarget.focus(), 0);
  }

  return ctx;
}

function confirmModal({
  title,
  text,
  confirmLabel = "确定",
  cancelLabel = "取消",
  danger = false,
  extra,
  initialFocus,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const ctx = openModal({
      title,
      initialFocus,
      build: ({ body }) => {
        if (text) body.appendChild(h("p", "modal-text", text));
        if (extra) extra(body);
      },
      footer: ({ foot }) => {
        const cancel = h("button", "btn", cancelLabel);
        cancel.type = "button";
        cancel.addEventListener("click", () => {
          done(false);
          ctx.close();
        });
        const ok = h("button", `btn ${danger ? "btn-danger" : "btn-primary"}`, confirmLabel);
        ok.type = "button";
        ok.addEventListener("click", () => {
          done(true);
          ctx.close();
        });
        foot.append(cancel, ok);
      },
      onClose: () => done(false),
    });
  });
}

function promptModal({
  title,
  label,
  value = "",
  placeholder = "",
  confirmLabel = "保存",
  maxLength,
  hint,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let input;
    const ctx = openModal({
      title,
      build: ({ body }) => {
        const field = h("div", "field");
        const lab = h("label", "field-label", label);
        lab.htmlFor = "prompt-input";
        input = h("input", "input");
        input.id = "prompt-input";
        input.type = "text";
        input.value = value;
        input.placeholder = placeholder;
        if (maxLength) input.maxLength = maxLength;
        field.append(lab, input);
        if (hint) field.appendChild(h("span", "field-hint", hint));
        body.appendChild(field);
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            submit();
          }
        });
      },
      footer: ({ foot }) => {
        const cancel = h("button", "btn", "取消");
        cancel.type = "button";
        cancel.addEventListener("click", () => {
          done(null);
          ctx.close();
        });
        const ok = h("button", "btn btn-primary", confirmLabel);
        ok.type = "button";
        ok.addEventListener("click", submit);
        foot.append(cancel, ok);
      },
      initialFocus: () => input,
      onClose: () => done(null),
    });
    function submit() {
      const v = input.value.trim();
      if (!v) {
        input.focus();
        return;
      }
      done(v);
      ctx.close();
    }
    window.setTimeout(() => input?.select(), 0);
  });
}

/* ══════════════════════════════════════════════════
   浮层菜单
   ══════════════════════════════════════════════════ */

let openMenuCleanup = null;

function closeFloatingMenu() {
  if (openMenuCleanup) {
    openMenuCleanup();
    openMenuCleanup = null;
  }
}

/**
 * entries: [{label, icon, danger, onClick} | {sep:true} | {header:'…'}]
 */
function openFloatingMenu(anchorEl, entries) {
  closeFloatingMenu();
  const menu = h("div", "menu menu-floating");
  menu.setAttribute("role", "menu");
  buildMenuEntries(menu, entries, () => closeFloatingMenu());
  document.body.appendChild(menu);

  const rect = anchorEl.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.min(rect.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = rect.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  anchorEl.classList.add("is-open");

  const onDocDown = (ev) => {
    if (!menu.contains(ev.target)) closeFloatingMenu();
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      closeFloatingMenu();
      if (typeof anchorEl.focus === "function") anchorEl.focus();
    }
  };
  const onScroll = () => closeFloatingMenu();

  window.setTimeout(() => document.addEventListener("mousedown", onDocDown), 0);
  document.addEventListener("keydown", onKey);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll);

  openMenuCleanup = () => {
    menu.remove();
    anchorEl.classList.remove("is-open");
    document.removeEventListener("mousedown", onDocDown);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
  };

  const first = menu.querySelector(FOCUSABLE);
  if (first) first.focus();
}

function buildMenuEntries(menu, entries, closeFn) {
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.sep) {
      menu.appendChild(h("div", "menu-sep"));
      continue;
    }
    if (entry.header) {
      menu.appendChild(h("div", "menu-label", entry.header));
      continue;
    }
    const btn = h("button", `menu-item${entry.danger ? " is-danger" : ""}`);
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    if (entry.icon) btn.appendChild(icon(entry.icon, 15));
    btn.appendChild(h("span", null, entry.label));
    btn.addEventListener("click", () => {
      closeFn();
      entry.onClick?.();
    });
    menu.appendChild(btn);
  }
}

/* ══════════════════════════════════════════════════
   视图切换
   ══════════════════════════════════════════════════ */

function setView(view, { closeDrawer = true } = {}) {
  state.view = view;
  // 页内搜索是"这个文件夹里找"，换了文件夹就该清空，不然会一头雾水
  state.folderQuery = "";
  // 选中的条目多半已经不在眼前了，留着只会造成误操作
  state.selection.clear();
  saveView();
  if (view.type === "folder" && view.id) {
    // 自动展开到该文件夹，免得用户切过去看不到自己在哪
    for (const f of folderPath(view.id)) {
      if (f.id !== view.id) state.expanded.add(f.id);
    }
    saveExpanded();
  }
  if (closeDrawer) setDrawer(false);
  if (view.type === "inbox") loadInbox();
  if (view.type === "shares") loadShares();
  if (view.type === "admin") loadAdmin();
  render();
  $("#main")?.scrollTo?.({ top: 0 });
}

function setDrawer(open) {
  const sidebar = $("#sidebar");
  const scrim = $("#drawer-scrim");
  const btn = $("#menu-btn");
  if (!sidebar || !scrim) return;
  sidebar.classList.toggle("is-open", open);
  scrim.hidden = !open;
  btn?.setAttribute("aria-expanded", open ? "true" : "false");
}

/* ══════════════════════════════════════════════════
   渲染：侧栏
   ══════════════════════════════════════════════════ */

function navItem({
  iconName,
  label,
  active,
  count,
  badge,
  depth = 0,
  onClick,
  onMore,
  onQuickAdd,
  dropFolderId,
  twisty,
}) {
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

  const main = h("button", "nav-main");
  main.type = "button";
  if (active) main.setAttribute("aria-current", "true");
  if (iconName) {
    const ic = icon(iconName, 15);
    ic.classList.add("nav-icon");
    main.appendChild(ic);
  }
  main.appendChild(h("span", "nav-label", label));
  if (badge) main.appendChild(h("span", "badge", String(badge)));
  else if (count !== undefined && count !== null && count > 0) {
    main.appendChild(h("span", "nav-count", String(count)));
  }
  main.addEventListener("click", onClick);
  row.appendChild(main);

  // 直接往这个文件夹里加一条，省掉"新建条目 → 再选文件夹"两步
  if (onQuickAdd) {
    const add = iconButton("plus", `在「${label}」中新建条目`, {
      className: "row-add",
      size: 14,
    });
    add.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onQuickAdd();
    });
    row.appendChild(add);
  }

  if (onMore) {
    const more = iconButton("more", "更多操作", { className: "row-more", size: 14 });
    more.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onMore(more);
    });
    row.appendChild(more);
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      onMore(more);
    });
  }

  // 拖拽落点：把条目拖到文件夹（或「全部」= 根目录）上完成移动
  if (dropFolderId !== undefined) {
    row.addEventListener("dragover", (ev) => {
      if (!state.dragItemId) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      row.classList.add("is-drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("is-drop"));
    row.addEventListener("drop", (ev) => {
      ev.preventDefault();
      row.classList.remove("is-drop");
      const id = state.dragItemId || ev.dataTransfer.getData("text/plain");
      if (id) moveItem(id, dropFolderId);
    });
  }

  return row;
}

function renderSidebar() {
  const nav = $("#sidebar-nav");
  if (!nav) return;
  clear(nav);

  nav.appendChild(
    navItem({
      iconName: "grid",
      label: "全部",
      active: state.view.type === "all",
      count: state.items.length,
      dropFolderId: null,
      onClick: () => setView({ type: "all" }),
    })
  );

  const section = h("div", "sidebar-section");
  const heading = h("div", "sidebar-heading");
  heading.appendChild(h("span", null, "文件夹"));
  heading.appendChild(h("span", null, String(state.folders.length)));
  section.appendChild(heading);

  const roots = childFolders(null);
  if (!roots.length) {
    const hint = h("p", "field-hint");
    hint.style.padding = "2px 10px 4px";
    hint.textContent = "还没有文件夹";
    section.appendChild(hint);
  }
  for (const f of roots) appendFolderRows(section, f, 0);
  nav.appendChild(section);

  const section2 = h("div", "sidebar-section");
  section2.appendChild(
    navItem({
      iconName: "inbox",
      label: "收到的分享",
      active: state.view.type === "inbox",
      badge: state.inboxCount > 0 ? state.inboxCount : null,
      onClick: () => setView({ type: "inbox" }),
    })
  );
  section2.appendChild(
    navItem({
      iconName: "share",
      label: "我的分享",
      active: state.view.type === "shares",
      onClick: () => setView({ type: "shares" }),
    })
  );
  nav.appendChild(section2);
}

function appendFolderRows(container, folder, depth) {
  const kids = childFolders(folder.id);
  const open = state.expanded.has(folder.id);
  container.appendChild(
    navItem({
      iconName: "folder",
      label: folder.name,
      active: state.view.type === "folder" && state.view.id === folder.id,
      // 含子文件夹的总数：折叠状态下只显示直属条目数会让人以为内容丢了
      count: itemsInSubtree(folder.id).length,
      depth,
      dropFolderId: folder.id,
      twisty: {
        open,
        leaf: kids.length === 0,
        onToggle: () => {
          if (open) state.expanded.delete(folder.id);
          else state.expanded.add(folder.id);
          saveExpanded();
          renderSidebar();
        },
      },
      onClick: () => setView({ type: "folder", id: folder.id }),
      onQuickAdd: () => openItemEditor(null, folder.id),
      onMore: (anchor) => openFolderMenu(anchor, folder),
    })
  );
  if (open) {
    for (const kid of kids) appendFolderRows(container, kid, depth + 1);
  }
}

/* ── 查看全文 ──
   卡片上的内容截到 4 行，长内容（比如一整篇笔记）在卡片里根本看不全。
   这里给一个只读的全文视图，带复制和转去编辑。 */
function openItemDetail(item) {
  let ctx;
  const path = item.folder_id ? folderLabel(item.folder_id) : "根目录";
  ctx = openModal({
    title: item.title || DEFAULT_TITLE,
    size: "modal-lg",
    build: ({ body }) => {
      const meta = h("p", "detail-meta");
      meta.textContent = `${path} · ${
        item.updated_at && item.updated_at !== item.created_at
          ? `更新于 ${absTime(item.updated_at)}`
          : `创建于 ${absTime(item.created_at)}`
      } · ${String(item.content ?? "").length} 字符`;
      body.appendChild(meta);

      const preview = contentPreview(item.content, {
        folderPath: item.folder_id ? folderLabel(item.folder_id) : "",
        large: true,
      });
      if (preview) body.appendChild(preview);

      const pre = h("pre", "detail-content");
      pre.textContent = item.content ?? "";
      body.appendChild(pre);
    },
    footer: ({ foot }) => {
      const edit = h("button", "btn", "编辑");
      edit.type = "button";
      edit.addEventListener("click", () => {
        ctx.close();
        openItemEditor(item);
      });

      const done = h("button", "btn", "关闭");
      done.type = "button";
      done.addEventListener("click", () => ctx.close());

      const copy = h("button", "btn btn-primary");
      copy.type = "button";
      copy.appendChild(icon("copy", 14, 2));
      copy.appendChild(h("span", null, "复制全部"));
      copy.addEventListener("click", () => copyAndFlash(copy, item.content));

      foot.append(edit, done, copy);
    },
  });
}

/* ── 批量选择 ── */

function clearSelection() {
  if (!state.selection.size) return;
  state.selection.clear();
  syncPickedUI();
  mountSelectionBar();
}

/** 把选中状态刷到已经渲染出来的卡片上，避免整树重建。 */
function syncPickedUI() {
  document.querySelectorAll("article.card").forEach((card) => {
    const on = state.selection.has(card.dataset.itemId);
    card.classList.toggle("is-picked", on);
    const box = card.querySelector(".card-pick input");
    if (box) box.checked = on;
  });
}

/** 当前视图里可见的条目，用于"全选"。 */
function visibleItems() {
  return Array.from(document.querySelectorAll("article.card"))
    .map((el) => el.dataset.itemId)
    .filter(Boolean);
}

function selectionBar() {
  const count = state.selection.size;
  if (!count) return null;

  const bar = h("div", "sel-bar");
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "批量操作");
  bar.appendChild(h("span", "sel-count", `已选 ${count} 项`));

  const visible = visibleItems();
  const allPicked = visible.length > 0 && visible.every((id) => state.selection.has(id));
  const all = h("button", "btn btn-sm");
  all.type = "button";
  all.textContent = allPicked ? "取消全选" : `全选本页 ${visible.length} 项`;
  all.addEventListener("click", () => {
    if (allPicked) visible.forEach((id) => state.selection.delete(id));
    else visible.forEach((id) => state.selection.add(id));
    syncPickedUI();
    mountSelectionBar();
  });

  const move = h("button", "btn btn-sm btn-primary");
  move.type = "button";
  move.appendChild(icon("folder", 14, 2));
  move.appendChild(h("span", null, "移动到…"));
  move.addEventListener("click", () => openBulkMove());

  const cancel = iconButton("x", "取消选择", { size: 15 });
  cancel.addEventListener("click", () => clearSelection());

  bar.append(all, move, cancel);
  return bar;
}

function openBulkMove() {
  const ids = Array.from(state.selection);
  if (!ids.length) return;
  let select;
  let errorBox;
  let ctx;

  ctx = openModal({
    title: `把 ${ids.length} 项移动到`,
    build: ({ body }) => {
      const field = h("div", "field");
      const lab = h("label", "field-label", "目标文件夹");
      lab.htmlFor = "bulk-folder";
      select = h("select", "select");
      select.id = "bulk-folder";
      buildFolderOptions(select);
      select.value = currentFolderId() ?? "";
      field.append(lab, select);
      body.appendChild(field);

      errorBox = h("p", "form-error");
      errorBox.hidden = true;
      errorBox.setAttribute("role", "alert");
      body.appendChild(errorBox);
    },
    initialFocus: () => select,
    footer: ({ foot }) => {
      const cancel = h("button", "btn", "取消");
      cancel.type = "button";
      cancel.addEventListener("click", () => ctx.close());

      const ok = h("button", "btn btn-primary", "移动");
      ok.type = "button";
      ok.addEventListener("click", async () => {
        const target = select.value || null;
        ok.disabled = true;
        ok.textContent = "移动中…";
        const failed = await bulkMove(ids, target);
        if (failed.length) {
          ok.disabled = false;
          ok.textContent = "移动";
          errorBox.hidden = false;
          errorBox.textContent = `有 ${failed.length} 项没能移动，请重试`;
          return;
        }
        ctx.close();
      });
      foot.append(cancel, ok);
    },
  });
}

/** 接口只支持单条改动，这里分批并发，避免一次几百个请求打满连接。 */
async function bulkMove(ids, folderId) {
  const targets = ids.filter((id) => {
    const it = state.items.find((x) => x.id === id);
    return it && (it.folder_id ?? null) !== (folderId ?? null);
  });
  const failed = [];
  const CHUNK = 6;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const batch = targets.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      batch.map((id) => api.updateItem(id, { folder_id: folderId ?? null }))
    );
    results.forEach((r, k) => {
      if (r.status === "fulfilled") {
        bumpRev(r.value);
        upsertItem(r.value?.item);
      } else {
        failed.push(batch[k]);
      }
    });
  }
  const moved = targets.length - failed.length;
  if (moved) {
    state.selection.clear();
    // 移动会影响多个文件夹的计数，直接全量重取最稳
    await refresh();
    toast(`已移动 ${moved} 项到「${folderId ? folderLabel(folderId) : "根目录"}」`, "success");
  } else if (!failed.length) {
    clearSelection();
    toast("选中的条目已经在该文件夹里", "info");
  }
  return failed;
}

function openFolderMenu(anchor, folder) {
  openFloatingMenu(anchor, [
    { label: "重命名", icon: "pencil", onClick: () => renameFolder(folder) },
    { label: "新建子文件夹", icon: "folderPlus", onClick: () => createFolder(folder.id) },
    {
      label: "分享此文件夹",
      icon: "share",
      onClick: () => openShareModal({ kind: "folder", id: folder.id, name: folder.name }),
    },
    { sep: true },
    { label: "删除文件夹", icon: "trash", danger: true, onClick: () => deleteFolder(folder) },
  ]);
}

/* ══════════════════════════════════════════════════
   渲染：条目卡片
   ══════════════════════════════════════════════════ */

function itemCard(item, index, { showFolder = false } = {}) {
  const card = h("article", `card${item.pinned ? " is-pinned" : ""}`);
  card.dataset.itemId = item.id; // 供"全选本页"识别当前渲染出来的条目
  // 只给首屏几张做入场动画。几百张一起动会让滚动和点击都发闷
  if (index < 18) card.style.animationDelay = `${index * 18}ms`;
  else card.style.animation = "none";
  card.draggable = true;
  card.addEventListener("dragstart", (ev) => {
    state.dragItemId = item.id;
    card.classList.add("is-dragging");
    try {
      ev.dataTransfer.setData("text/plain", item.id);
      ev.dataTransfer.effectAllowed = "move";
    } catch (_) {}
  });
  card.addEventListener("dragend", () => {
    state.dragItemId = null;
    card.classList.remove("is-dragging");
    document
      .querySelectorAll(".nav-item.is-drop")
      .forEach((n) => n.classList.remove("is-drop"));
  });

  const head = h("div", "card-head");

  const pick = h("label", "card-pick");
  const box = h("input");
  box.type = "checkbox";
  box.checked = state.selection.has(item.id);
  box.setAttribute("aria-label", `选择「${item.title || DEFAULT_TITLE}」`);
  box.addEventListener("change", () => {
    if (box.checked) state.selection.add(item.id);
    else state.selection.delete(item.id);
    card.classList.toggle("is-picked", box.checked);
    // 只更新操作条，不重绘网格 —— 重绘 300 多张卡片会连带重放入场动画，
    // 表现就是每点一下整页闪一下
    mountSelectionBar();
  });
  pick.appendChild(box);
  head.appendChild(pick);
  if (box.checked) card.classList.add("is-picked");

  const title = h("h3", "card-title");
  if (item.pinned) {
    const mark = h("span", "pin-mark");
    mark.appendChild(icon("pin", 13, 2));
    mark.setAttribute("title", "已置顶");
    title.appendChild(mark);
  }
  title.appendChild(document.createTextNode(item.title || DEFAULT_TITLE));
  head.appendChild(title);

  const copyBtn = h("button", "copy-btn");
  copyBtn.type = "button";
  copyBtn.setAttribute("aria-label", `复制「${item.title || DEFAULT_TITLE}」的内容`);
  copyBtn.appendChild(icon("copy", 14, 2));
  copyBtn.appendChild(h("span", null, "复制"));
  copyBtn.addEventListener("click", () => copyAndFlash(copyBtn, item.content));
  head.appendChild(copyBtn);
  card.appendChild(head);

  const media = h("div", "card-media");
  // 插件认得这段内容就在左边补一张预览，不认得就整行都给文本
  const preview = contentPreview(item.content, {
    folderPath: item.folder_id ? folderLabel(item.folder_id) : "",
  });
  if (preview) media.appendChild(preview);

  const body = h("div", "card-body");
  // 文字放内层：.card-body 是 flex 子项，display:-webkit-box 会被浏览器
  // blockify 掉，line-clamp 随之失效，只剩硬切出半个字
  const bodyText = h("div", "card-body-text");
  if (item.content) bodyText.textContent = item.content;
  else {
    body.classList.add("is-empty");
    bodyText.textContent = "（空内容）";
  }
  body.appendChild(bodyText);
  // 卡片里的内容被截到 4 行，点一下看全文
  body.tabIndex = 0;
  body.setAttribute("role", "button");
  body.setAttribute("aria-label", `查看「${item.title || DEFAULT_TITLE}」全文`);
  body.addEventListener("click", () => openItemDetail(item));
  body.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      openItemDetail(item);
    }
  });
  media.appendChild(body);
  card.appendChild(media);

  const foot = h("div", "card-foot");
  const meta = h("div", "meta");
  meta.textContent =
    item.updated_at && item.updated_at !== item.created_at
      ? `更新于 ${relTime(item.updated_at)}`
      : `创建于 ${relTime(item.created_at)}`;
  meta.title = `创建：${absTime(item.created_at)}\n更新：${absTime(item.updated_at)}`;
  foot.appendChild(meta);

  if (showFolder) {
    const tag = h("span", "tag");
    tag.appendChild(icon("folder", 11, 2));
    tag.appendChild(h("span", null, item.folder_id ? folderLeaf(item.folder_id) : "根目录"));
    tag.title = item.folder_id ? folderLabel(item.folder_id) : "根目录";
    foot.appendChild(tag);
  }

  const tools = h("div", "card-tools");
  const editBtn = iconButton("pencil", "编辑", { size: 15 });
  editBtn.addEventListener("click", () => openItemEditor(item));
  const pinBtn = iconButton("pin", item.pinned ? "取消置顶" : "置顶", { size: 15 });
  if (item.pinned) pinBtn.classList.add("is-on");
  pinBtn.addEventListener("click", () => togglePin(item));
  const shareBtn = iconButton("share", "分享", { size: 15 });
  shareBtn.addEventListener("click", () =>
    openShareModal({ kind: "item", id: item.id, name: item.title || DEFAULT_TITLE })
  );
  const delBtn = iconButton("trash", "删除", { size: 15 });
  delBtn.classList.add("is-danger");
  delBtn.addEventListener("click", () => deleteItem(item));
  tools.append(editBtn, pinBtn, shareBtn, delBtn);
  foot.appendChild(tools);

  card.appendChild(foot);
  return card;
}

function emptyState(titleText, text, actionLabel, onAction) {
  const box = h("div", "empty");
  const mark = h("div", "empty-mark");
  mark.appendChild(icon("box", 36, 1.3));
  box.appendChild(mark);
  box.appendChild(h("p", "empty-title", titleText));
  if (text) box.appendChild(h("p", "empty-text", text));
  if (actionLabel) {
    const btn = labeledButton("plus", actionLabel, "btn btn-primary");
    btn.addEventListener("click", onAction);
    box.appendChild(btn);
  }
  return box;
}

function loadingState(text = "加载中…") {
  const box = h("div", "state-page");
  box.appendChild(h("span", "spinner"));
  box.appendChild(h("p", "state-text", text));
  return box;
}

/* ══════════════════════════════════════════════════
   渲染：主内容区
   ══════════════════════════════════════════════════ */

function render() {
  renderSidebar();
  renderView();
}

function mountSelectionBar() {
  document.getElementById("sel-bar")?.remove();
  const bar = selectionBar();
  if (!bar) return;
  bar.id = "sel-bar";
  document.body.appendChild(bar);
}

function renderView() {
  const root = $("#view");
  if (!root) return;
  // 离开管理员面板时必须停掉倒计时，否则会一直空转并意外重绘
  stopInviteTimer();
  clear(root);
  renderViewBody(root);
  // 必须放在正文渲染之后：操作条要数当前渲染出来的卡片来算"全选本页"
  mountSelectionBar();
}

function renderViewBody(root) {
  if (state.query.trim()) {
    renderSearch(root);
    return;
  }
  switch (state.view.type) {
    case "inbox":
      renderInbox(root);
      break;
    case "shares":
      renderShares(root);
      break;
    case "admin":
      renderAdmin(root);
      break;
    case "folder":
      renderItems(root, state.view.id);
      break;
    default:
      renderItems(root, undefined);
  }
}

/** 文件夹页内的搜索框。就地过滤当前文件夹（含子文件夹），
 *  与顶栏那个"跨全部文件夹"的搜索各管各的，省得为了在本文件夹里
 *  找一条内容还要跑回左上角。 */
function folderSearchBox(folder) {
  const wrap = h("div", "inline-search");
  wrap.appendChild(icon("search", 15, 2));

  const input = h("input", "inline-search-input");
  input.type = "search";
  input.value = state.folderQuery;
  input.placeholder = `在「${folder.name}」中搜索`;
  input.setAttribute("aria-label", `在「${folder.name}」及其子文件夹中搜索`);
  input.autocomplete = "off";
  input.spellcheck = false;

  const clearBtn = iconButton("x", "清除", { size: 13 });
  clearBtn.classList.add("inline-search-clear");
  clearBtn.hidden = !state.folderQuery;

  const apply = (value) => {
    state.folderQuery = value;
    renderView();
    // 重绘会换掉输入框，焦点和光标位置要接回去
    const next = $(".inline-search-input");
    if (next) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  };

  input.addEventListener("input", () => apply(input.value));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && input.value) {
      ev.stopPropagation();
      apply("");
    }
  });
  clearBtn.addEventListener("click", () => apply(""));

  wrap.append(input, clearBtn);
  return wrap;
}

function viewHead(root, { titleText, sub, crumbs, actions }) {
  const head = h("div", "view-head");
  const left = h("div");
  if (crumbs) left.appendChild(crumbs);
  const t = h("h1", "view-title", titleText);
  left.appendChild(t);
  if (sub) left.appendChild(h("p", "view-sub", sub));
  head.appendChild(left);
  if (actions) {
    const box = h("div", "view-actions");
    actions.forEach((a) => box.appendChild(a));
    head.appendChild(box);
  }
  root.appendChild(head);
  return head;
}

function buildCrumbs(folderId) {
  const crumbs = h("nav", "crumbs");
  crumbs.setAttribute("aria-label", "路径");
  const rootBtn = h("button", "crumb", "全部");
  rootBtn.type = "button";
  rootBtn.addEventListener("click", () => setView({ type: "all" }));
  crumbs.appendChild(rootBtn);
  const path = folderPath(folderId);
  path.forEach((f, i) => {
    crumbs.appendChild(h("span", null, "/"));
    const isLast = i === path.length - 1;
    if (isLast) {
      crumbs.appendChild(h("span", "crumb is-current", f.name));
    } else {
      const b = h("button", "crumb", f.name);
      b.type = "button";
      b.addEventListener("click", () => setView({ type: "folder", id: f.id }));
      crumbs.appendChild(b);
    }
  });
  return crumbs;
}

function renderItems(root, folderId) {
  const isAll = folderId === undefined;
  const folder = isAll ? null : folderById(folderId);

  // 文件夹被别处删掉后，视图要自愈回「全部」
  if (!isAll && !folder) {
    state.view = { type: "all" };
    saveView();
    renderItems(root, undefined);
    return;
  }

  // 文件夹视图连子文件夹的内容一起显示，与侧栏计数同口径
  const kids = isAll ? [] : childFolders(folderId);
  const all = isAll ? sortItems(state.items) : itemsInSubtree(folderId);
  // 页内搜索就地过滤，不跳到"搜索结果"页 —— 人还在这个文件夹里
  const fq = isAll ? "" : state.folderQuery.trim().toLowerCase();
  const list = fq ? all.filter((it) => matchesQuery(it, fq)) : all;
  const actions = [];
  if (!isAll) {
    actions.push(folderSearchBox(folder));
    const shareBtn = labeledButton("share", "分享文件夹", "btn btn-sm");
    shareBtn.addEventListener("click", () =>
      openShareModal({ kind: "folder", id: folder.id, name: folder.name })
    );
    actions.push(shareBtn);
    const subBtn = labeledButton("folderPlus", "新建子文件夹", "btn btn-sm");
    subBtn.addEventListener("click", () => createFolder(folder.id));
    actions.push(subBtn);
  }

  const scopeNote = kids.length ? ` · 含 ${kids.length} 个子文件夹` : "";
  viewHead(root, {
    titleText: isAll ? "全部条目" : folder.name,
    sub: fq
      ? `“${state.folderQuery.trim()}” 匹配 ${list.length} / 共 ${all.length} 条${scopeNote}`
      : `${all.length} 条${isAll ? "" : scopeNote}`,
    crumbs: isAll ? null : buildCrumbs(folderId),
    actions: actions.length ? actions : null,
  });

  if (!list.length) {
    if (fq) {
      root.appendChild(
        emptyState(
          "这个文件夹里没有匹配的内容",
          `「${folder.name}」及其子文件夹里没找到“${state.folderQuery.trim()}”，用顶栏的搜索框可以搜全部文件夹。`
        )
      );
      return;
    }
    root.appendChild(
      emptyState(
        "这里还没有内容",
        isAll
          ? "点右上角「新建条目」把第一段文本存进来，换台设备就能一键复制。"
          : "这个文件夹是空的，新建一条内容试试。",
        "新建条目",
        () => openItemEditor(null, isAll ? null : folderId)
      )
    );
    return;
  }

  const grid = h("div", "grid");
  // 有子文件夹时给每张卡片标出出处，否则分不清哪条来自哪个子文件夹
  const showFolder = isAll || kids.length > 0;
  list.forEach((item, i) => grid.appendChild(itemCard(item, i, { showFolder })));
  root.appendChild(grid);
}

function renderSearch(root) {
  const q = state.query.trim();
  const list = searchItems(q);
  viewHead(root, {
    titleText: "搜索结果",
    sub: `“${q}” 匹配到 ${list.length} 条（跨全部文件夹）`,
  });
  if (!list.length) {
    root.appendChild(emptyState("没有匹配的条目", "换个关键词试试，搜索会同时匹配标题与内容。"));
    return;
  }
  const grid = h("div", "grid");
  list.forEach((item, i) => grid.appendChild(itemCard(item, i, { showFolder: true })));
  root.appendChild(grid);
}

/* ── 收到的分享 ── */

function shareItemsOf(payload) {
  if (!payload) return [];
  if (payload.kind === "item") return payload.item ? [payload.item] : [];
  return Array.isArray(payload.items) ? payload.items : [];
}

function shareSummary(payload) {
  if (!payload) return "（空分享）";
  if (payload.kind === "item") return payload.item?.title || DEFAULT_TITLE;
  return payload.name || "未命名文件夹";
}

function sharePreviewText(payload) {
  const items = shareItemsOf(payload);
  if (!items.length) return "（空内容）";
  return items
    .map((it) => String(it.content ?? ""))
    .join("\n\n")
    .slice(0, 4000);
}

function renderInbox(root) {
  viewHead(root, {
    titleText: "收到的分享",
    sub: state.inbox
      ? `${state.inbox.length} 条${state.inboxCount ? ` · ${state.inboxCount} 条待处理` : ""}`
      : "正在加载…",
    actions: [refreshButton(() => loadInbox(true))],
  });

  if (state.inbox === null) {
    root.appendChild(loadingState("正在读取收件箱…"));
    return;
  }
  if (!state.inbox.length) {
    root.appendChild(
      emptyState("收件箱是空的", "别人把条目或文件夹分享给你时，会出现在这里。")
    );
    return;
  }

  const list = h("div", "list");
  state.inbox.forEach((share, i) => {
    const accepted = !!share.accepted_at;
    const card = h("div", `row-card${accepted ? " is-accepted" : ""}`);
    card.style.animationDelay = `${Math.min(i, 12) * 18}ms`;

    const head = h("div", "row-head");
    head.appendChild(h("span", "row-title", shareSummary(share.payload)));
    const kindTag = h("span", "tag");
    kindTag.textContent =
      share.payload?.kind === "folder"
        ? `文件夹 · ${shareItemsOf(share.payload).length} 条`
        : "条目";
    head.appendChild(kindTag);
    if (accepted) {
      const t = h("span", "tag tag-success", "已存入");
      head.appendChild(t);
    }

    const actions = h("div", "row-actions");
    const copyBtn = h("button", "copy-btn");
    copyBtn.type = "button";
    copyBtn.appendChild(icon("copy", 14, 2));
    copyBtn.appendChild(h("span", null, "复制"));
    copyBtn.setAttribute("aria-label", "复制分享内容");
    copyBtn.addEventListener("click", () =>
      copyAndFlash(copyBtn, shareItemsOf(share.payload).map((it) => it.content ?? "").join("\n\n"))
    );
    actions.appendChild(copyBtn);

    const saveBtn = labeledButton("save", "存入我的");
    saveBtn.addEventListener("click", () => acceptShare(share));
    actions.appendChild(saveBtn);

    const delBtn = labeledButton("trash", "删除", "btn btn-sm btn-danger-ghost");
    delBtn.addEventListener("click", () => removeInboxShare(share));
    actions.appendChild(delBtn);

    head.appendChild(actions);
    card.appendChild(head);

    const meta = h("div", "meta");
    meta.textContent = `来自 ${share.from ?? "未知用户"} · ${relTime(share.created_at)}`;
    meta.title = absTime(share.created_at);
    card.appendChild(meta);

    const preview = h("div", "row-preview");
    preview.textContent = sharePreviewText(share.payload);
    card.appendChild(preview);

    list.appendChild(card);
  });
  root.appendChild(list);
}

/* ── 我的分享 ── */

function renderShares(root) {
  viewHead(root, {
    titleText: "我的分享",
    sub: "发出的定向分享与公开链接",
    actions: [refreshButton(() => loadShares(true))],
  });

  if (state.outbox === null || state.links === null) {
    root.appendChild(loadingState("正在读取分享记录…"));
    return;
  }

  root.appendChild(sectionTitle("我发出的", state.outbox.length));
  if (!state.outbox.length) {
    root.appendChild(emptyState("还没有发出过分享", "在条目卡片或文件夹菜单里点「分享」。"));
  } else {
    const list = h("div", "list");
    state.outbox.forEach((s, i) => {
      const card = h("div", "row-card");
      card.style.animationDelay = `${Math.min(i, 12) * 18}ms`;
      const head = h("div", "row-head");
      head.appendChild(h("span", "row-title", s.summary || DEFAULT_TITLE));
      head.appendChild(h("span", "tag", s.kind === "folder" ? "文件夹" : "条目"));
      head.appendChild(h("span", "tag tag-accent", `发给 ${s.to ?? "?"}`));
      if (s.accepted) head.appendChild(h("span", "tag tag-success", "已接受"));

      const actions = h("div", "row-actions");
      if (s.accepted) {
        const hint = h("span", "meta", "对方已存入，不可撤回");
        actions.appendChild(hint);
      } else {
        const revoke = labeledButton("undo", "撤回", "btn btn-sm btn-danger-ghost");
        revoke.addEventListener("click", () => revokeShare(s));
        actions.appendChild(revoke);
      }
      head.appendChild(actions);
      card.appendChild(head);

      const meta = h("div", "meta");
      meta.textContent = relTime(s.created_at);
      meta.title = absTime(s.created_at);
      card.appendChild(meta);
      list.appendChild(card);
    });
    root.appendChild(list);
  }

  root.appendChild(sectionTitle("公开链接", state.links.length));
  if (!state.links.length) {
    root.appendChild(emptyState("还没有公开链接", "生成的链接免登录即可打开，可随时撤销。"));
    return;
  }
  const list2 = h("div", "list");
  state.links.forEach((link, i) => {
    const url = `${window.location.origin}${link.url || `/s/${link.token}`}`;
    const card = h("div", "row-card");
    card.style.animationDelay = `${Math.min(i, 12) * 18}ms`;

    const head = h("div", "row-head");
    head.appendChild(h("span", "row-title", link.summary || DEFAULT_TITLE));
    head.appendChild(h("span", "tag", link.kind === "folder" ? "文件夹" : "条目"));
    const expTag = h("span", "tag");
    expTag.textContent = link.expires_at
      ? `${absTime(link.expires_at)} 过期`
      : "永久有效";
    head.appendChild(expTag);

    const actions = h("div", "row-actions");
    const open = h("a", "btn btn-sm", "打开");
    open.href = url;
    open.target = "_blank";
    open.rel = "noopener";
    actions.appendChild(open);
    const revoke = labeledButton("trash", "撤销", "btn btn-sm btn-danger-ghost");
    revoke.addEventListener("click", () => revokeLink(link));
    actions.appendChild(revoke);
    head.appendChild(actions);
    card.appendChild(head);

    const urlRow = h("div", "row-head");
    const urlBox = h("div", "link-url", url);
    urlBox.title = url;
    urlRow.appendChild(urlBox);
    const copyBtn = h("button", "copy-btn");
    copyBtn.type = "button";
    copyBtn.appendChild(icon("link", 14, 2));
    copyBtn.appendChild(h("span", null, "复制链接"));
    copyBtn.addEventListener("click", () => copyAndFlash(copyBtn, url));
    urlRow.appendChild(copyBtn);
    card.appendChild(urlRow);

    const meta = h("div", "meta");
    meta.textContent = `创建于 ${relTime(link.created_at)}`;
    meta.title = absTime(link.created_at);
    card.appendChild(meta);

    list2.appendChild(card);
  });
  root.appendChild(list2);
}

function sectionTitle(text, count) {
  const t = h("h2", "section-title");
  t.appendChild(h("span", null, text));
  if (count !== undefined) t.appendChild(h("span", "tag", String(count)));
  return t;
}

function refreshButton(onClick) {
  const btn = labeledButton("refresh", "刷新");
  btn.addEventListener("click", onClick);
  return btn;
}

/* ══════════════════════════════════════════════════
   条目操作
   ══════════════════════════════════════════════════ */

function upsertItem(item) {
  if (!item) return;
  const idx = state.items.findIndex((it) => it.id === item.id);
  if (idx >= 0) state.items[idx] = item;
  else state.items.push(item);
}

function bumpRev(res) {
  if (res && typeof res.rev === "number") state.rev = res.rev;
}

function openItemEditor(item, presetFolderId) {
  const isNew = !item;
  let titleInput;
  let contentInput;
  let folderSelect;
  let errorBox;
  let saveBtn; // footer 回调里赋值；不能引用外层 ctx（此时还在 TDZ）
  let saving = false;

  const ctx = openModal({
    title: isNew ? "新建条目" : "编辑条目",
    size: "modal-lg",
    build: ({ body }) => {
      titleInput = h("input", "input editor-title");
      titleInput.type = "text";
      titleInput.placeholder = "标题（留空则为「未命名」）";
      titleInput.maxLength = MAX_TITLE_LEN;
      titleInput.value = item?.title ?? "";
      titleInput.setAttribute("aria-label", "标题");
      body.appendChild(titleInput);

      body.appendChild(h("hr", "divider"));

      contentInput = h("textarea", "textarea editor-textarea");
      contentInput.placeholder = "把内容粘贴到这里…";
      contentInput.value = item?.content ?? "";
      contentInput.spellcheck = false;
      contentInput.setAttribute("aria-label", "内容");
      body.appendChild(contentInput);

      const field = h("div", "field");
      field.style.marginTop = "var(--s-4)";
      const lab = h("label", "field-label", "所在文件夹");
      lab.htmlFor = "editor-folder";
      folderSelect = h("select", "select");
      folderSelect.id = "editor-folder";
      buildFolderOptions(folderSelect);
      const current = isNew ? presetFolderId ?? currentFolderId() : item.folder_id;
      folderSelect.value = current ?? "";
      field.append(lab, folderSelect);
      body.appendChild(field);

      errorBox = h("p", "form-error");
      errorBox.hidden = true;
      errorBox.setAttribute("role", "alert");
      body.appendChild(errorBox);

      const onKey = (ev) => {
        if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
          ev.preventDefault();
          submit();
        }
      };
      titleInput.addEventListener("keydown", onKey);
      contentInput.addEventListener("keydown", onKey);
    },
    footer: ({ foot, close }) => {
      const hint = h("span", "foot-hint");
      hint.appendChild(h("span", "kbd", isMac() ? "⌘" : "Ctrl"));
      hint.appendChild(h("span", "kbd", "Enter"));
      hint.appendChild(h("span", null, "保存"));
      foot.appendChild(hint);

      const cancel = h("button", "btn", "取消");
      cancel.type = "button";
      cancel.addEventListener("click", close);
      saveBtn = h("button", "btn btn-primary", isNew ? "创建" : "保存");
      saveBtn.type = "button";
      saveBtn.addEventListener("click", submit);
      foot.append(cancel, saveBtn);
    },
    initialFocus: () => (isNew ? contentInput : titleInput),
  });

  async function submit() {
    if (saving) return;
    const title = titleInput.value.trim();
    const content = contentInput.value;
    if (content.length > MAX_CONTENT_LEN) {
      showError(`内容超过 ${MAX_CONTENT_LEN} 字符上限（当前 ${content.length}）`);
      return;
    }
    const folderId = folderSelect.value || null;
    saving = true;
    if (saveBtn) saveBtn.disabled = true;
    try {
      if (isNew) {
        const res = await api.createItem({ title, content, folder_id: folderId });
        bumpRev(res);
        upsertItem(res?.item);
        toast("已创建", "success");
      } else {
        const patch = {};
        if (title !== (item.title ?? "")) patch.title = title;
        if (content !== (item.content ?? "")) patch.content = content;
        if ((folderId ?? null) !== (item.folder_id ?? null)) patch.folder_id = folderId;
        if (!Object.keys(patch).length) {
          ctx.close();
          return;
        }
        const res = await api.updateItem(item.id, patch);
        bumpRev(res);
        upsertItem(res?.item);
        toast("已保存", "success");
      }
      ctx.close();
      render();
    } catch (err) {
      showError(errMessage(err));
    } finally {
      saving = false;
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function showError(msg) {
    errorBox.hidden = false;
    clear(errorBox);
    errorBox.appendChild(icon("alert", 15));
    errorBox.appendChild(h("span", null, msg));
  }
}

function currentFolderId() {
  return state.view.type === "folder" ? state.view.id : null;
}

function isMac() {
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
}

/** 往 <select> 里灌「根目录 + 全部文件夹」，用缩进体现层级。 */
function buildFolderOptions(select, { rootLabel = "根目录（不归类）" } = {}) {
  clear(select);
  const rootOpt = h("option", null, rootLabel);
  rootOpt.value = "";
  select.appendChild(rootOpt);
  const walk = (parentId, depth) => {
    for (const f of childFolders(parentId)) {
      const opt = h("option", null, `${"　".repeat(depth)}${depth ? "└ " : ""}${f.name}`);
      opt.value = f.id;
      select.appendChild(opt);
      if (depth < MAX_DEPTH_GUARD) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
}

async function togglePin(item) {
  try {
    const res = await api.updateItem(item.id, { pinned: !item.pinned });
    bumpRev(res);
    upsertItem(res?.item);
    render();
  } catch (err) {
    reportError(err);
  }
}

async function deleteItem(item) {
  const ok = await confirmModal({
    title: "删除条目",
    text: `确定删除「${item.title || DEFAULT_TITLE}」吗？此操作不可撤销。`,
    confirmLabel: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api.deleteItem(item.id);
    bumpRev(res);
    state.items = state.items.filter((it) => it.id !== item.id);
    render();
    toast("已删除", "success");
  } catch (err) {
    reportError(err);
    if (err instanceof ApiError && err.status === 404) refresh();
  }
}

async function moveItem(itemId, folderId) {
  const item = state.items.find((it) => it.id === itemId);
  if (!item) return;
  if ((item.folder_id ?? null) === (folderId ?? null)) return;
  try {
    const res = await api.updateItem(itemId, { folder_id: folderId ?? null });
    bumpRev(res);
    upsertItem(res?.item);
    render();
    toast(`已移动到「${folderId ? folderLabel(folderId) : "根目录"}」`, "success");
  } catch (err) {
    reportError(err);
  }
}

/* ══════════════════════════════════════════════════
   文件夹操作
   ══════════════════════════════════════════════════ */

async function createFolder(parentId = null) {
  const name = await promptModal({
    title: parentId ? `在「${folderById(parentId)?.name ?? ""}」下新建子文件夹` : "新建文件夹",
    label: "文件夹名称",
    placeholder: "例如：项目",
    confirmLabel: "创建",
    maxLength: MAX_FOLDER_NAME,
  });
  if (!name) return;
  try {
    const res = await api.createFolder({ name, parent_id: parentId ?? null });
    bumpRev(res);
    if (res?.folder) {
      state.folders.push(res.folder);
      if (parentId) state.expanded.add(parentId);
      saveExpanded();
      setView({ type: "folder", id: res.folder.id });
    } else {
      await refresh();
    }
    toast("文件夹已创建", "success");
  } catch (err) {
    reportError(err);
  }
}

async function renameFolder(folder) {
  const name = await promptModal({
    title: "重命名文件夹",
    label: "文件夹名称",
    value: folder.name,
    maxLength: MAX_FOLDER_NAME,
  });
  if (!name || name === folder.name) return;
  try {
    const res = await api.updateFolder(folder.id, { name });
    bumpRev(res);
    if (res?.folder) {
      const idx = state.folders.findIndex((f) => f.id === folder.id);
      if (idx >= 0) state.folders[idx] = res.folder;
    }
    render();
    toast("已重命名", "success");
  } catch (err) {
    reportError(err);
  }
}

async function deleteFolder(folder) {
  const inside = itemsOfFolder(folder.id).length;
  const subCount = subtreeIds(folder.id).size - 1;
  let cascade = false;

  const ok = await confirmModal({
    title: `删除文件夹「${folder.name}」`,
    text: `该文件夹直属 ${inside} 条条目、${subCount} 个子文件夹。请选择删除方式：`,
    confirmLabel: "删除",
    danger: true,
    extra: (body) => {
      const group = h("div", "radio-cards");
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", "删除方式");
      const opts = [
        {
          value: false,
          name: "仅删除文件夹",
          desc: "里面的条目和子文件夹会上移到上一级，内容不丢。",
        },
        {
          value: true,
          name: "连同内容一起删除",
          desc: "递归删除整个子树及其中全部条目，不可恢复。",
        },
      ];
      const buttons = [];
      opts.forEach((o) => {
        const btn = h("button", "radio-card");
        btn.type = "button";
        btn.setAttribute("role", "radio");
        btn.setAttribute("aria-checked", o.value === cascade ? "true" : "false");
        btn.appendChild(h("span", "radio-dot"));
        const main = h("span", "radio-main");
        main.appendChild(h("span", "radio-name", o.name));
        main.appendChild(h("span", "radio-desc", o.desc));
        btn.appendChild(main);
        btn.addEventListener("click", () => {
          cascade = o.value;
          buttons.forEach((b, i) =>
            b.setAttribute("aria-checked", opts[i].value === cascade ? "true" : "false")
          );
        });
        buttons.push(btn);
        group.appendChild(btn);
      });
      body.appendChild(group);
    },
  });
  if (!ok) return;

  try {
    const res = await api.deleteFolder(folder.id, { cascade });
    bumpRev(res);
    // 级联删除影响面广（子树 + 条目），直接强制全量拉一次最稳
    if (state.view.type === "folder" && subtreeIds(folder.id).has(state.view.id)) {
      state.view = { type: "all" };
      saveView();
    }
    await refresh();
    const n = res?.deleted_items ?? 0;
    toast(cascade ? `已删除文件夹与 ${n} 条条目` : "已删除文件夹，内容已上移", "success");
  } catch (err) {
    reportError(err);
  }
}

/* ══════════════════════════════════════════════════
   分享
   ══════════════════════════════════════════════════ */

const EXPIRY_CHOICES = [
  { label: "1 小时", value: 3600 },
  { label: "1 天", value: 86400 },
  { label: "7 天", value: 604800 },
  { label: "永久", value: null },
];

function openShareModal({ kind, id, name }) {
  let activeTab = "direct";
  let panel;
  const ctx = openModal({
    title: `分享${kind === "folder" ? "文件夹" : "条目"}「${name}」`,
    size: "modal-lg",
    flush: true,
    build: ({ body }) => {
      const tabs = h("div", "tabs");
      tabs.setAttribute("role", "tablist");
      const mk = (key, label) => {
        const b = h("button", "tab", label);
        b.type = "button";
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", key === activeTab ? "true" : "false");
        b.addEventListener("click", () => {
          activeTab = key;
          Array.from(tabs.children).forEach((c) =>
            c.setAttribute("aria-selected", c === b ? "true" : "false")
          );
          paint();
        });
        return b;
      };
      tabs.append(mk("direct", "发给用户"), mk("link", "公开链接"));
      body.appendChild(tabs);

      panel = h("div");
      panel.style.padding = "var(--s-5)";
      body.appendChild(panel);
      paint();
    },
  });

  function paint() {
    clear(panel);
    if (activeTab === "direct") paintDirect();
    else paintLink();
  }

  function paintDirect() {
    const field = h("div", "field");
    const lab = h("label", "field-label", "对方用户名");
    lab.htmlFor = "share-to";
    const input = h("input", "input");
    input.id = "share-to";
    input.type = "text";
    input.placeholder = "对方在 ClipNest 的用户名";
    input.autocomplete = "off";
    input.spellcheck = false;
    field.append(lab, input);
    field.appendChild(
      h("span", "field-hint", "对方会在「收到的分享」里看到一份快照，你之后的修改不影响它。")
    );
    panel.appendChild(field);

    const err = h("p", "form-error");
    err.hidden = true;
    err.setAttribute("role", "alert");
    err.style.marginTop = "var(--s-4)";
    panel.appendChild(err);

    const row = h("div", "row-actions");
    row.style.marginTop = "var(--s-5)";
    const send = h("button", "btn btn-primary", "发送");
    send.type = "button";
    row.appendChild(send);
    panel.appendChild(row);

    const submit = async () => {
      const to = input.value.trim();
      if (!to) {
        input.focus();
        return;
      }
      send.disabled = true;
      err.hidden = true;
      try {
        await api.shareDirect({ to, kind, id });
        toast(`已分享给 ${to}`, "success");
        state.outbox = null; // 让「我的分享」下次进入时重拉
        ctx.close();
      } catch (e) {
        err.hidden = false;
        clear(err);
        err.appendChild(icon("alert", 15));
        err.appendChild(h("span", null, errMessage(e)));
      } finally {
        send.disabled = false;
      }
    };
    send.addEventListener("click", submit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submit();
      }
    });
    window.setTimeout(() => input.focus(), 0);
  }

  function paintLink() {
    let expires = null;
    const field = h("div", "field");
    field.appendChild(h("span", "field-label", "有效期"));
    const chips = h("div", "chips");
    chips.setAttribute("role", "radiogroup");
    chips.setAttribute("aria-label", "链接有效期");
    const btns = [];
    EXPIRY_CHOICES.forEach((c) => {
      const b = h("button", "chip", c.label);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", c.value === expires ? "true" : "false");
      b.addEventListener("click", () => {
        expires = c.value;
        btns.forEach((x, i) =>
          x.setAttribute("aria-checked", EXPIRY_CHOICES[i].value === expires ? "true" : "false")
        );
      });
      btns.push(b);
      chips.appendChild(b);
    });
    field.appendChild(chips);
    field.appendChild(h("span", "field-hint", "拿到链接的人无需登录即可只读查看并复制。"));
    panel.appendChild(field);

    const err = h("p", "form-error");
    err.hidden = true;
    err.setAttribute("role", "alert");
    err.style.marginTop = "var(--s-4)";
    panel.appendChild(err);

    const result = h("div");
    result.style.marginTop = "var(--s-4)";
    panel.appendChild(result);

    const row = h("div", "row-actions");
    row.style.marginTop = "var(--s-5)";
    const gen = h("button", "btn btn-primary", "生成链接");
    gen.type = "button";
    row.appendChild(gen);
    panel.appendChild(row);

    gen.addEventListener("click", async () => {
      gen.disabled = true;
      err.hidden = true;
      try {
        const res = await api.createLink({ kind, id, expires_in: expires });
        const link = res?.link;
        const url = `${window.location.origin}${link?.url || `/s/${link?.token ?? ""}`}`;
        clear(result);
        const box = h("div", "row-head");
        const urlBox = h("div", "link-url", url);
        urlBox.title = url;
        box.appendChild(urlBox);
        const copyBtn = h("button", "copy-btn");
        copyBtn.type = "button";
        copyBtn.appendChild(icon("link", 14, 2));
        copyBtn.appendChild(h("span", null, "复制链接"));
        copyBtn.addEventListener("click", () => copyAndFlash(copyBtn, url));
        box.appendChild(copyBtn);
        result.appendChild(box);
        const meta = h("p", "field-hint");
        meta.style.marginTop = "var(--s-2)";
        meta.textContent = link?.expires_at
          ? `将于 ${absTime(link.expires_at)} 过期`
          : "永久有效，可在「我的分享」里撤销";
        result.appendChild(meta);
        state.links = null;
        toast("链接已生成", "success");
        window.setTimeout(() => copyBtn.focus(), 0);
      } catch (e) {
        err.hidden = false;
        clear(err);
        err.appendChild(icon("alert", 15));
        err.appendChild(h("span", null, errMessage(e)));
      } finally {
        gen.disabled = false;
      }
    });
  }
}

/* ── 分享数据加载 ── */

async function loadInbox(force = false) {
  if (state.inbox !== null && !force) return;
  if (force) state.inbox = null;
  try {
    const res = await api.getInbox();
    state.inbox = Array.isArray(res?.shares) ? res.shares : [];
    // 顺手校正角标：这是最新鲜的一手数据
    state.inboxCount = state.inbox.filter((s) => !s.accepted_at).length;
    render();
  } catch (err) {
    state.inbox = [];
    reportError(err);
    if (state.view.type === "inbox") renderView();
  }
}

async function loadShares(force = false) {
  if (state.outbox !== null && state.links !== null && !force) return;
  if (force) {
    state.outbox = null;
    state.links = null;
  }
  try {
    const [ob, lk] = await Promise.all([api.getOutbox(), api.getLinks()]);
    state.outbox = Array.isArray(ob?.shares) ? ob.shares : [];
    state.links = Array.isArray(lk?.links) ? lk.links : [];
  } catch (err) {
    state.outbox = state.outbox ?? [];
    state.links = state.links ?? [];
    reportError(err);
  }
  if (state.view.type === "shares") renderView();
}

async function acceptShare(share) {
  const folderId = await pickFolder({
    title: "存入哪个文件夹？",
    confirmLabel: "存入",
  });
  if (folderId === undefined) return; // 用户取消
  try {
    const res = await api.acceptShare(share.id, { folder_id: folderId });
    bumpRev(res);
    await refresh();
    await loadInbox(true);
    const n = res?.created_items ?? 0;
    toast(`已存入 ${n} 条内容`, "success");
  } catch (err) {
    reportError(err);
  }
}

async function removeInboxShare(share) {
  const ok = await confirmModal({
    title: "删除分享",
    text: "从收件箱移除这条分享？已存入我的内容不会受影响。",
    confirmLabel: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteInboxShare(share.id);
    state.inbox = (state.inbox || []).filter((s) => s.id !== share.id);
    if (!share.accepted_at) state.inboxCount = Math.max(0, state.inboxCount - 1);
    render();
    toast("已从收件箱移除", "success");
  } catch (err) {
    reportError(err);
  }
}

async function revokeShare(s) {
  const ok = await confirmModal({
    title: "撤回分享",
    text: `撤回发给 ${s.to ?? ""} 的「${s.summary || DEFAULT_TITLE}」？对方收件箱中的副本会被删除。`,
    confirmLabel: "撤回",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.revokeOutboxShare(s.id);
    state.outbox = (state.outbox || []).filter((x) => x.id !== s.id);
    renderView();
    toast("已撤回", "success");
  } catch (err) {
    reportError(err);
    if (err instanceof ApiError && err.code === "conflict") loadShares(true);
  }
}

async function revokeLink(link) {
  const ok = await confirmModal({
    title: "撤销公开链接",
    text: "撤销后该链接立即失效，已经拿到链接的人也打不开了。",
    confirmLabel: "撤销",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteLink(link.token);
    state.links = (state.links || []).filter((l) => l.token !== link.token);
    renderView();
    toast("链接已撤销", "success");
  } catch (err) {
    reportError(err);
  }
}

/** 文件夹选择器。取消返回 undefined，选根目录返回 null。 */
function pickFolder({ title, confirmLabel = "确定", initial = null }) {
  return new Promise((resolve) => {
    let picked = initial;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const ctx = openModal({
      title,
      build: ({ body }) => {
        const list = h("div", "choice-list");
        list.setAttribute("role", "radiogroup");
        const rows = [];
        const add = (label, value, depth) => {
          const b = h("button", "choice");
          b.type = "button";
          b.setAttribute("role", "radio");
          b.setAttribute("aria-checked", value === picked ? "true" : "false");
          if (depth) {
            const pad = h("span", "choice-indent");
            pad.style.width = `${depth * 14}px`;
            b.appendChild(pad);
          }
          b.appendChild(icon(value === null ? "grid" : "folder", 14));
          b.appendChild(h("span", null, label));
          b.addEventListener("click", () => {
            picked = value;
            rows.forEach(([node, val]) =>
              node.setAttribute("aria-checked", val === picked ? "true" : "false")
            );
          });
          rows.push([b, value]);
          list.appendChild(b);
        };
        add("根目录（不归类）", null, 0);
        const walk = (parentId, depth) => {
          for (const f of childFolders(parentId)) {
            add(f.name, f.id, depth + 1);
            if (depth < MAX_DEPTH_GUARD) walk(f.id, depth + 1);
          }
        };
        walk(null, 0);
        body.appendChild(list);
      },
      footer: ({ foot }) => {
        const cancel = h("button", "btn", "取消");
        cancel.type = "button";
        cancel.addEventListener("click", () => {
          done(undefined);
          ctx.close();
        });
        const ok = h("button", "btn btn-primary", confirmLabel);
        ok.type = "button";
        ok.addEventListener("click", () => {
          done(picked);
          ctx.close();
        });
        foot.append(cancel, ok);
      },
      onClose: () => done(undefined),
    });
  });
}

/* ══════════════════════════════════════════════════
   管理员面板
   ══════════════════════════════════════════════════ */

let inviteTimer = null;

function stopInviteTimer() {
  if (inviteTimer) {
    window.clearInterval(inviteTimer);
    inviteTimer = null;
  }
}

async function loadAdmin(force = false) {
  if (state.user?.role !== "admin") return;
  if (state.admin.users !== null && !force) return;
  state.admin.loading = true;
  try {
    const [invite, settings, users] = await Promise.all([
      api.adminInvite(),
      api.adminGetSettings(),
      api.adminListUsers(),
    ]);
    state.admin.invite = invite ?? null;
    state.admin.settings = settings ?? null;
    state.admin.users = Array.isArray(users?.users) ? users.users : [];
  } catch (err) {
    reportError(err);
    state.admin.users = state.admin.users ?? [];
  } finally {
    state.admin.loading = false;
  }
  if (state.view.type === "admin") renderView();
}

function renderAdmin(root) {
  stopInviteTimer();

  if (state.user?.role !== "admin") {
    root.appendChild(emptyState("无权访问", "只有管理员才能查看这个页面。"));
    return;
  }

  viewHead(root, {
    titleText: "管理员面板",
    sub: "邀请码、注册开关与用户管理",
    actions: [refreshButton(() => loadAdmin(true))],
  });

  if (state.admin.users === null) {
    root.appendChild(loadingState("正在读取管理数据…"));
    return;
  }

  const grid = h("div", "admin-grid");

  /* 邀请码 */
  const invitePanel = h("div", "panel");
  const ih = h("div", "panel-head");
  ih.appendChild(icon("lock", 14));
  ih.appendChild(h("span", null, "当前邀请码"));
  invitePanel.appendChild(ih);
  const ib = h("div", "panel-body");
  const invite = state.admin.invite;
  if (invite?.code) {
    const row = h("div", "invite-row");
    row.appendChild(h("div", "invite-code", invite.code));
    const copyBtn = h("button", "copy-btn");
    copyBtn.type = "button";
    copyBtn.appendChild(icon("copy", 14, 2));
    copyBtn.appendChild(h("span", null, "复制"));
    copyBtn.addEventListener("click", () => copyAndFlash(copyBtn, invite.code));
    row.appendChild(copyBtn);
    ib.appendChild(row);

    const cd = h("div", "countdown");
    const label = h("span", null, "");
    const bar = h("div", "countdown-bar");
    const fill = h("div", "countdown-fill");
    bar.appendChild(fill);
    cd.append(label, bar);
    ib.appendChild(cd);

    let left = Number(invite.expires_in) || 0;
    const period = Number(invite.period) || 600;
    const paint = () => {
      label.textContent = `${Math.max(0, left)} 秒后轮换`;
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, left / period))})`;
    };
    paint();
    inviteTimer = window.setInterval(async () => {
      left -= 1;
      if (left <= 0) {
        // 归零就重新取一次，拿到新码后整块重绘
        stopInviteTimer();
        try {
          state.admin.invite = await api.adminInvite();
        } catch (_) {
          /* 取不到就等用户手动刷新 */
        }
        if (state.view.type === "admin") renderView();
        return;
      }
      paint();
    }, 1000);
  } else {
    ib.appendChild(h("p", "field-hint", "暂时取不到邀请码，请点右上角刷新。"));
  }
  invitePanel.appendChild(ib);
  grid.appendChild(invitePanel);

  /* 注册开关 */
  const setPanel = h("div", "panel");
  const sh = h("div", "panel-head");
  sh.appendChild(icon("users", 14));
  sh.appendChild(h("span", null, "注册开关"));
  setPanel.appendChild(sh);
  const sb = h("div", "panel-body");
  const switchRow = h("div", "switch-row");
  const main = h("div", "switch-main");
  const open = !!state.admin.settings?.registration_open;
  main.appendChild(h("div", null, open ? "已开放注册" : "已关闭注册"));
  main.appendChild(
    h("div", "field-hint", open ? "任何持有当前邀请码的人都能注册。" : "关闭期间即便有邀请码也无法注册。")
  );
  const sw = h("button", "switch");
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", open ? "true" : "false");
  sw.setAttribute("aria-label", "注册开关");
  sw.addEventListener("click", async () => {
    sw.disabled = true;
    try {
      const res = await api.adminSetSettings({ registration_open: !open });
      state.admin.settings = res ?? { registration_open: !open };
      toast(state.admin.settings.registration_open ? "已开放注册" : "已关闭注册", "success");
      renderView();
    } catch (err) {
      reportError(err);
      sw.disabled = false;
    }
  });
  switchRow.append(main, sw);
  sb.appendChild(switchRow);
  setPanel.appendChild(sb);
  grid.appendChild(setPanel);

  root.appendChild(grid);

  /* 用户表 */
  const panel = h("div", "panel");
  const ph = h("div", "panel-head");
  ph.appendChild(icon("users", 14));
  ph.appendChild(h("span", null, `用户（${state.admin.users.length}）`));
  panel.appendChild(ph);

  const wrap = h("div", "table-wrap");
  const table = h("table", "table");
  const thead = h("thead");
  const trh = h("tr");
  ["用户名", "角色", "注册时间", "条目", "文件夹", "状态", ""].forEach((t) => {
    const th = h("th", null, t);
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = h("tbody");
  for (const u of state.admin.users) {
    const tr = h("tr");
    tr.appendChild(h("td", "cell-name", u.username));
    const roleTd = h("td");
    roleTd.appendChild(
      h("span", u.role === "admin" ? "tag tag-accent" : "tag", u.role === "admin" ? "管理员" : "用户")
    );
    tr.appendChild(roleTd);
    tr.appendChild(h("td", null, absTime(u.created_at, false)));
    tr.appendChild(h("td", "cell-num", String(u.item_count ?? 0)));
    tr.appendChild(h("td", "cell-num", String(u.folder_count ?? 0)));
    const stTd = h("td");
    stTd.appendChild(
      u.disabled ? h("span", "tag", "已禁用") : h("span", "tag tag-success", "正常")
    );
    tr.appendChild(stTd);

    const actTd = h("td");
    const acts = h("div", "cell-actions");
    const isSelf = u.username === state.user?.username;

    const toggleBtn = labeledButton(u.disabled ? "refresh" : "ban", u.disabled ? "解禁" : "禁用");
    toggleBtn.disabled = isSelf;
    if (isSelf) toggleBtn.title = "不能禁用自己";
    toggleBtn.addEventListener("click", () => toggleUserDisabled(u));
    acts.appendChild(toggleBtn);

    const resetBtn = labeledButton("lock", "重置密码");
    resetBtn.addEventListener("click", () => resetUserPassword(u));
    acts.appendChild(resetBtn);

    const delBtn = labeledButton("trash", "删除", "btn btn-sm btn-danger-ghost");
    delBtn.disabled = isSelf;
    if (isSelf) delBtn.title = "不能删除自己";
    delBtn.addEventListener("click", () => deleteUser(u));
    acts.appendChild(delBtn);

    actTd.appendChild(acts);
    tr.appendChild(actTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  panel.appendChild(wrap);
  root.appendChild(panel);
}

async function toggleUserDisabled(u) {
  const next = !u.disabled;
  if (next) {
    const ok = await confirmModal({
      title: `禁用 ${u.username}`,
      text: "禁用后该用户所有已登录设备立即失效，数据保留。",
      confirmLabel: "禁用",
      danger: true,
    });
    if (!ok) return;
  }
  try {
    const res = await api.adminUpdateUser(u.username, { disabled: next });
    const updated = res?.user;
    if (updated && state.admin.users) {
      const idx = state.admin.users.findIndex((x) => x.username === u.username);
      if (idx >= 0) state.admin.users[idx] = updated;
    } else {
      u.disabled = next;
    }
    renderView();
    toast(next ? "已禁用" : "已解禁", "success");
  } catch (err) {
    reportError(err);
  }
}

async function resetUserPassword(u) {
  const ok = await confirmModal({
    title: `重置 ${u.username} 的密码`,
    text: "会生成一个随机新密码，该用户所有已登录设备立即失效。新密码只显示这一次。",
    confirmLabel: "重置",
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api.adminResetPassword(u.username);
    showSecretModal(`${u.username} 的新密码`, res?.password ?? "");
  } catch (err) {
    reportError(err);
  }
}

function showSecretModal(title, secret) {
  openModal({
    title,
    build: ({ body }) => {
      const warn = h("p", "form-error");
      warn.appendChild(icon("alert", 15));
      warn.appendChild(h("span", null, "这串密码只显示这一次，关闭后无法再次查看，请立即保存。"));
      body.appendChild(warn);
      const row = h("div", "secret");
      row.style.marginTop = "var(--s-4)";
      const value = h("div", "secret-value", secret);
      row.appendChild(value);
      const copyBtn = h("button", "copy-btn copy-btn-lg");
      copyBtn.type = "button";
      copyBtn.appendChild(icon("copy", 15, 2));
      copyBtn.appendChild(h("span", null, "复制"));
      copyBtn.addEventListener("click", () => copyAndFlash(copyBtn, secret));
      row.appendChild(copyBtn);
      body.appendChild(row);
    },
    footer: ({ foot, close }) => {
      const done = h("button", "btn btn-primary", "我已保存");
      done.type = "button";
      done.addEventListener("click", close);
      foot.appendChild(done);
    },
  });
}

async function deleteUser(u) {
  let input;
  const ok = await confirmModal({
    title: `删除用户 ${u.username}`,
    text: "该用户的全部条目、文件夹、分享与公开链接都会被永久删除，无法恢复。请输入用户名以确认：",
    confirmLabel: "永久删除",
    danger: true,
    extra: (body) => {
      input = h("input", "input");
      input.type = "text";
      input.placeholder = u.username;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("aria-label", "输入用户名以确认删除");
      input.style.marginTop = "var(--s-3)";
      body.appendChild(input);
    },
    initialFocus: () => input,
  });
  if (!ok) return;
  if ((input?.value || "").trim().toLowerCase() !== u.username.toLowerCase()) {
    toast("用户名不匹配，已取消删除", "error");
    return;
  }
  try {
    await api.adminDeleteUser(u.username);
    state.admin.users = (state.admin.users || []).filter((x) => x.username !== u.username);
    renderView();
    toast("用户已删除", "success");
  } catch (err) {
    reportError(err);
  }
}

/* ══════════════════════════════════════════════════
   同步
   ══════════════════════════════════════════════════ */

let pollTimer = null;
let failureCount = 0;

function applyStore(data) {
  state.rev = typeof data.rev === "number" ? data.rev : state.rev;
  state.folders = Array.isArray(data.folders) ? data.folders : [];
  state.items = Array.isArray(data.items) ? data.items : [];
  state.inboxCount = Number(data.inbox_count ?? 0) || 0;
}

async function pull({ force = false } = {}) {
  try {
    const data = await api.getStore(force ? -1 : state.rev);
    setOffline(false);
    if (!data) return;
    if (data.changed) {
      applyStore(data);
      render();
      return;
    }
    if (typeof data.rev === "number") state.rev = data.rev;
    // 收到分享只写对方的 inbox.json，不会动我的 store rev，所以后端在
    // changed:false 时也下发 inbox_count；角标真的变了才重绘侧栏
    const pending = Number(data.inbox_count ?? state.inboxCount) || 0;
    if (pending !== state.inboxCount) {
      state.inboxCount = pending;
      renderSidebar();
      if (state.view.type === "inbox") loadInbox(true);
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return; // 已被 api 层处理
    failureCount += 1;
    if (failureCount >= 2) setOffline(true);
  }
}

function refresh() {
  return pull({ force: true });
}

function setOffline(off) {
  if (!off) failureCount = 0;
  if (state.offline === off) return;
  state.offline = off;
  const badge = $("#conn-badge");
  if (badge) badge.hidden = !off;
}

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(() => {
    if (document.hidden) return;
    pull();
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function onVisibilityChange() {
  if (document.hidden) {
    stopPolling(); // 后台标签页不发请求
  } else if (state.user) {
    pull(); // 回到前台立刻补一次
    startPolling();
  }
}

/* ══════════════════════════════════════════════════
   登录 / 注册界面
   ══════════════════════════════════════════════════ */

let authMode = "login";

function showAuth() {
  stopPolling();
  stopInviteTimer();
  closeFloatingMenu();
  state.user = null;
  $("#app").hidden = true;
  $("#auth-screen").hidden = false;
  const u = $("#auth-username");
  if (u) window.setTimeout(() => u.focus(), 0);
}

function showApp() {
  $("#auth-screen").hidden = true;
  $("#app").hidden = false;
}

function setAuthMode(mode) {
  authMode = mode;
  const isReg = mode === "register";
  $("#auth-tab-login").setAttribute("aria-selected", isReg ? "false" : "true");
  $("#auth-tab-register").setAttribute("aria-selected", isReg ? "true" : "false");
  $("#auth-invite-field").hidden = !isReg;
  $("#auth-password-hint").hidden = !isReg;
  $("#auth-submit").textContent = isReg ? "注册并登录" : "登录";
  $("#auth-password").setAttribute(
    "autocomplete",
    isReg ? "new-password" : "current-password"
  );
  setAuthError("");
}

function setAuthError(msg) {
  const box = $("#auth-error");
  if (!box) return;
  if (!msg) {
    box.hidden = true;
    clear(box);
    return;
  }
  box.hidden = false;
  clear(box);
  box.appendChild(icon("alert", 15));
  box.appendChild(h("span", null, msg));
}

async function submitAuth(ev) {
  ev.preventDefault();
  const submit = $("#auth-submit");
  const username = $("#auth-username").value.trim();
  const password = $("#auth-password").value;
  const invite = $("#auth-invite").value.trim();

  if (!USERNAME_RE.test(username)) {
    setAuthError("用户名需为 3-32 位字母、数字、下划线或连字符");
    $("#auth-username").focus();
    return;
  }
  if (authMode === "register" && password.length < MIN_PASSWORD) {
    setAuthError(`密码至少 ${MIN_PASSWORD} 位`);
    $("#auth-password").focus();
    return;
  }
  if (!password) {
    setAuthError("请输入密码");
    $("#auth-password").focus();
    return;
  }
  if (authMode === "register" && !invite) {
    setAuthError("请输入邀请码");
    $("#auth-invite").focus();
    return;
  }

  setAuthError("");
  submit.disabled = true;
  try {
    const res =
      authMode === "register"
        ? await api.register({ username, password, invite_code: invite })
        : await api.login({ username, password });
    if (res?.token) setToken(res.token);
    $("#auth-password").value = "";
    $("#auth-invite").value = "";
    await onLoggedIn(res?.user ?? null);
  } catch (err) {
    setAuthError(errMessage(err));
  } finally {
    submit.disabled = false;
  }
}

async function onLoggedIn(user) {
  if (!user) {
    try {
      const res = await api.me();
      user = res?.user ?? null;
    } catch (_) {
      user = null;
    }
  }
  state.user = user;
  paintUserChip();
  showApp();
  state.view = loadView();
  if (state.view.type === "admin" && user?.role !== "admin") state.view = { type: "all" };
  render();
  await pull({ force: true });
  render();
  if (state.view.type === "inbox") loadInbox();
  if (state.view.type === "shares") loadShares();
  if (state.view.type === "admin") loadAdmin();
  startPolling();
}

function paintUserChip() {
  const name = state.user?.username ?? "";
  $("#user-name").textContent = name;
  $("#user-avatar").textContent = name ? name.slice(0, 1) : "?";
  $("#user-btn").setAttribute("aria-label", `${name} 的账户菜单`);
  $("#admin-btn").hidden = state.user?.role !== "admin";
}

/* ══════════════════════════════════════════════════
   用户菜单 / 改密码
   ══════════════════════════════════════════════════ */

function toggleUserMenu() {
  const menu = $("#user-menu");
  const btn = $("#user-btn");
  if (!menu) return;
  const willOpen = menu.hidden;
  clear(menu);
  if (!willOpen) {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    return;
  }
  buildMenuEntries(
    menu,
    [
      { header: state.user?.username ?? "" },
      { label: "修改密码", icon: "lock", onClick: openChangePassword },
      { label: "我的分享", icon: "share", onClick: () => setView({ type: "shares" }) },
      { sep: true },
      { label: "退出登录", icon: "logout", danger: true, onClick: logout },
    ],
    () => closeUserMenu()
  );
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  const first = menu.querySelector(FOCUSABLE);
  if (first) first.focus();

  window.setTimeout(() => {
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEsc);
  }, 0);

  function onOutside(ev) {
    if (!menu.contains(ev.target) && ev.target !== btn) closeUserMenu();
  }
  function onEsc(ev) {
    if (ev.key === "Escape") {
      closeUserMenu();
      btn.focus();
    }
  }
  function closeUserMenu() {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onOutside);
    document.removeEventListener("keydown", onEsc);
  }
}

function openChangePassword() {
  let oldInput;
  let newInput;
  let repeatInput;
  let errBox;
  let okBtn; // 同 openItemEditor：footer 回调里不能引用还在 TDZ 的 ctx
  const ctx = openModal({
    title: "修改密码",
    build: ({ body }) => {
      const mk = (labelText, id, autocomplete) => {
        const field = h("div", "field");
        const lab = h("label", "field-label", labelText);
        lab.htmlFor = id;
        const input = h("input", "input");
        input.type = "password";
        input.id = id;
        input.autocomplete = autocomplete;
        field.append(lab, input);
        body.appendChild(field);
        return input;
      };
      oldInput = mk("当前密码", "pw-old", "current-password");
      newInput = mk("新密码", "pw-new", "new-password");
      repeatInput = mk("再输一次", "pw-repeat", "new-password");
      body.appendChild(
        h("p", "field-hint", `至少 ${MIN_PASSWORD} 位。修改后其他设备需要重新登录。`)
      );
      errBox = h("p", "form-error");
      errBox.hidden = true;
      errBox.setAttribute("role", "alert");
      errBox.style.marginTop = "var(--s-4)";
      body.appendChild(errBox);
      [oldInput, newInput, repeatInput].forEach((i) =>
        i.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            submit();
          }
        })
      );
    },
    footer: ({ foot, close }) => {
      const cancel = h("button", "btn", "取消");
      cancel.type = "button";
      cancel.addEventListener("click", close);
      okBtn = h("button", "btn btn-primary", "保存");
      okBtn.type = "button";
      okBtn.addEventListener("click", submit);
      foot.append(cancel, okBtn);
    },
  });

  async function submit() {
    const oldPw = oldInput.value;
    const newPw = newInput.value;
    if (newPw.length < MIN_PASSWORD) return showErr(`新密码至少 ${MIN_PASSWORD} 位`);
    if (newPw !== repeatInput.value) return showErr("两次输入的新密码不一致");
    if (okBtn) okBtn.disabled = true;
    try {
      const res = await api.changePassword({ old_password: oldPw, new_password: newPw });
      // 后端会自增 token_version，必须换用返回的新 token，否则当前设备立刻掉线
      if (res?.token) setToken(res.token);
      ctx.close();
      toast("密码已修改，其他设备需要重新登录", "success");
    } catch (err) {
      showErr(errMessage(err));
    } finally {
      if (okBtn) okBtn.disabled = false;
    }
  }

  function showErr(msg) {
    errBox.hidden = false;
    clear(errBox);
    errBox.appendChild(icon("alert", 15));
    errBox.appendChild(h("span", null, msg));
  }
}

function logout() {
  clearToken();
  stopPolling();
  state.rev = -1;
  state.folders = [];
  state.items = [];
  state.inbox = null;
  state.outbox = null;
  state.links = null;
  state.inboxCount = 0;
  state.admin = { invite: null, settings: null, users: null, loading: false };
  state.query = "";
  const s = $("#search-input");
  if (s) s.value = "";
  showAuth();
}

/* ══════════════════════════════════════════════════
   事件绑定与启动
   ══════════════════════════════════════════════════ */

function wireEvents() {
  $("#auth-tab-login").addEventListener("click", () => setAuthMode("login"));
  $("#auth-tab-register").addEventListener("click", () => setAuthMode("register"));
  $("#auth-form").addEventListener("submit", submitAuth);

  $("#theme-btn").addEventListener("click", cycleTheme);
  $("#menu-btn").addEventListener("click", () =>
    setDrawer(!$("#sidebar").classList.contains("is-open"))
  );
  $("#drawer-scrim").addEventListener("click", () => setDrawer(false));
  $("#brand-home").addEventListener("click", (ev) => {
    ev.preventDefault();
    setView({ type: "all" });
  });
  $("#new-item-btn").addEventListener("click", () => openItemEditor(null, currentFolderId()));
  // 建在根级：按钮写的就是"新建文件夹"。建子文件夹有专门的入口
  // （文件夹行的 ⋯ 菜单、文件夹页头部的按钮），不能让这个跟着当前选中走，
  // 否则选中任何文件夹后就再也建不出同级目录了。
  $("#new-folder-btn").addEventListener("click", () => createFolder(null));
  $("#admin-btn").addEventListener("click", () => setView({ type: "admin" }));
  $("#user-btn").addEventListener("click", toggleUserMenu);

  const search = $("#search-input");
  const clearBtn = $("#search-clear");
  search.addEventListener("input", () => {
    state.query = search.value;
    if (!search.value.trim()) state.searchAll = false;
    $("#search-wrap").classList.toggle("has-value", !!search.value);
    clearBtn.hidden = !search.value;
    renderView();
  });
  search.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && search.value) {
      ev.stopPropagation();
      resetSearch();
    }
  });
  clearBtn.addEventListener("click", () => {
    resetSearch();
    search.focus();
  });

  // 全局快捷键：/ 或 ⌘/Ctrl+K 聚焦搜索
  document.addEventListener("keydown", (ev) => {
    if (modalStack.length) return;
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || document.activeElement?.isContentEditable;
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      search.focus();
      search.select();
      return;
    }
    if (ev.key === "/" && !typing && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      search.focus();
    }
  });

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", () => {
    if (state.user) pull();
  });

  // 拖拽结束后清理落点高亮（拖到窗口外时 dragend 可能不触发在卡片上）
  document.addEventListener("dragend", () => {
    state.dragItemId = null;
    document
      .querySelectorAll(".nav-item.is-drop")
      .forEach((n) => n.classList.remove("is-drop"));
  });
}

function resetSearch() {
  const search = $("#search-input");
  search.value = "";
  state.query = "";
  $("#search-wrap").classList.remove("has-value");
  $("#search-clear").hidden = true;
  renderView();
}

async function boot() {
  applyTheme(readTheme());
  wireEvents();
  setAuthMode("login");
  setUnauthorizedHandler(() => {
    if (state.user) toast("登录状态已失效，请重新登录", "error");
    logout();
  });

  if (!getToken()) {
    showAuth();
    return;
  }

  // 有 token：先验一次身份。网络不通时不要粗暴踢回登录页，重试即可。
  let attempt = 0;
  while (true) {
    try {
      const res = await api.me();
      await onLoggedIn(res?.user ?? null);
      return;
    } catch (err) {
      if (err instanceof ApiError) {
        // 401 已清 token；其余错误也回登录页，避免卡在空白页
        showAuth();
        if (err.status !== 401) setAuthError(errMessage(err));
        return;
      }
      attempt += 1;
      setOffline(true);
      if (attempt >= 3) {
        showAuth();
        setAuthError("连不上服务器，请检查网络后重试");
        return;
      }
      await new Promise((r) => window.setTimeout(r, 1500 * attempt));
    }
  }
}

boot();
