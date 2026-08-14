/* ClipNest 公开分享只读页。
 *
 * 免登录：只调 GET /api/public/<token>。
 * 所有分享内容一律 textContent 写入 —— 这是别人给的数据，绝不能碰 innerHTML。
 */

import { api, ApiError } from "./api.js";

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

/** 快照内的相对路径：folders[].parent_id 指向快照内的 id，根为 null。 */
function buildPathMap(rootName, folders) {
  const byId = new Map();
  (folders || []).forEach((f) => {
    if (f && f.id) byId.set(f.id, f);
  });
  const cache = new Map();
  const pathOf = (fid) => {
    if (!fid) return rootName;
    if (cache.has(fid)) return cache.get(fid);
    const parts = [];
    let cur = byId.get(fid);
    let guard = 0;
    while (cur && guard++ < 32) {
      parts.unshift(cur.name ?? "");
      cur = cur.parent_id ? byId.get(cur.parent_id) : null;
    }
    const full = [rootName, ...parts].join(" / ");
    cache.set(fid, full);
    return full;
  };
  return pathOf;
}

function renderItemPayload(payload, meta) {
  const item = payload.item || {};
  const title = item.title || DEFAULT_TITLE;
  document.title = `${title} · ClipNest 分享`;

  clear(main);
  const head = h("div", "share-head");
  head.appendChild(h("h1", "share-title", title));
  head.appendChild(copyButton(() => item.content ?? "", { large: true }));
  main.appendChild(head);
  main.appendChild(meta);

  const pre = h("pre", "share-content");
  pre.textContent = item.content ?? "";
  main.appendChild(pre);
}

function renderFolderPayload(payload, meta) {
  const name = payload.name || "未命名文件夹";
  const items = Array.isArray(payload.items) ? payload.items : [];
  document.title = `${name} · ClipNest 分享`;
  const pathOf = buildPathMap(name, payload.folders);

  clear(main);
  const head = h("div", "share-head");
  const titleBox = h("div");
  titleBox.style.flex = "1";
  titleBox.style.minWidth = "0";
  const t = h("h1", "share-title", name);
  titleBox.appendChild(t);
  titleBox.appendChild(h("p", "state-text", `文件夹 · 共 ${items.length} 条内容`));
  head.appendChild(titleBox);
  if (items.length) {
    head.appendChild(
      copyButton(() => items.map((it) => it.content ?? "").join("\n\n"), {
        large: true,
        label: "复制全部",
      })
    );
  }
  main.appendChild(head);
  main.appendChild(meta);

  if (!items.length) {
    const box = h("div", "empty");
    box.appendChild(h("p", "empty-title", "这个文件夹是空的"));
    main.appendChild(box);
    return;
  }

  // 平铺全部条目，每条标注它在快照里的路径
  items.forEach((item, i) => {
    const card = h("div", "share-item");
    card.style.animationDelay = `${Math.min(i, 12) * 20}ms`;

    const ih = h("div", "share-item-head");
    const titles = h("div", "share-item-titles");
    titles.appendChild(h("div", "row-title", item.title || DEFAULT_TITLE));
    const path = h("div", "share-path");
    path.appendChild(document.createTextNode(pathOf(item.folder_id ?? null)));
    titles.appendChild(path);
    ih.appendChild(titles);
    ih.appendChild(copyButton(() => item.content ?? "", { label: "复制" }));
    card.appendChild(ih);

    const body = h("div", "share-item-body");
    body.textContent = item.content ?? "";
    card.appendChild(body);

    main.appendChild(card);
  });
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
