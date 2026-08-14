/* ClipNest API 封装 —— 严格对应 docs/API.md 第 12 节。
 *
 * 约定：
 *   - token 存 localStorage，key = "clipnest_token"
 *   - 所有请求自动带 Authorization: Bearer <token>
 *   - 非 2xx 解析 {error:{code,message}} 抛 ApiError（带 code / message / status）
 *   - 401 → 清 token 并回调外部注入的处理器（本文件不碰 DOM，便于复用与测试）
 *   - 204 不解析 JSON
 */

export const TOKEN_KEY = "clipnest_token";

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** 网络层错误（请求根本没发出去 / 断网）与业务错误区分开，轮询时用它决定静默重试。 */
export class NetworkError extends Error {
  constructor(message) {
    super(message || "网络连接失败");
    this.name = "NetworkError";
    this.code = "network_error";
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch (_) {
    // 隐私模式下 localStorage 可能抛异常，退化为「未登录」
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (_) {
    /* 存不进去也不影响本次会话 */
  }
}

export function clearToken() {
  setToken(null);
}

let unauthorizedHandler = null;

/** 注入 401 处理器（由 app.js 传入，负责切回登录界面）。 */
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

function buildQuery(params) {
  const usable = Object.entries(params || {}).filter(
    ([, v]) => v !== undefined && v !== null
  );
  if (!usable.length) return "";
  const qs = new URLSearchParams();
  for (const [k, v] of usable) qs.set(k, String(v));
  return `?${qs.toString()}`;
}

/**
 * @param {object} opts
 *   auth   —— 是否附带 Authorization（公开接口传 false）
 *   silent —— 401 时不触发全局登出（公开页 / 登录请求本身）
 */
async function request(method, path, body, opts = {}) {
  const { auth = true, silent = false } = opts;
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const token = auth ? getToken() : null;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch (_) {
    throw new NetworkError();
  }

  if (res.status === 401 && !silent) {
    clearToken();
    if (unauthorizedHandler) {
      try {
        unauthorizedHandler();
      } catch (_) {
        /* 处理器自身异常不应吞掉原始错误 */
      }
    }
  }

  // 204 / 205 与空体：不要尝试解析 JSON
  if (res.status === 204 || res.status === 205) {
    if (!res.ok) throw new ApiError("internal_error", "请求失败", res.status);
    return null;
  }

  let data = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = null;
    }
  }

  if (!res.ok) {
    const err = data && typeof data === "object" ? data.error : null;
    const code = err?.code || "internal_error";
    const message = err?.message || fallbackMessage(res.status);
    throw new ApiError(code, message, res.status);
  }

  return data;
}

function fallbackMessage(status) {
  switch (status) {
    case 400:
      return "请求格式有误";
    case 401:
      return "登录状态已失效，请重新登录";
    case 403:
      return "没有权限执行此操作";
    case 404:
      return "内容不存在或已被删除";
    case 409:
      return "操作冲突，请刷新后重试";
    case 413:
      return "内容太大了，请精简后再试";
    case 429:
      return "操作太频繁，请稍后再试";
    default:
      return "服务器开小差了，请稍后重试";
  }
}

export const api = {
  /* ── 认证 ───────────────────────────────────── */

  // 登录 / 注册失败返回 401 时不应触发「全局登出」——本来就没登录，所以 silent
  register({ username, password, invite_code }) {
    return request(
      "POST",
      "/api/auth/register",
      { username, password, invite_code },
      { auth: false, silent: true }
    );
  },

  login({ username, password }) {
    return request(
      "POST",
      "/api/auth/login",
      { username, password },
      { auth: false, silent: true }
    );
  },

  me() {
    return request("GET", "/api/auth/me");
  },

  changePassword({ old_password, new_password }) {
    // 旧密码错误也返回 401，但这不该把用户踢下线 → silent
    return request(
      "POST",
      "/api/auth/password",
      { old_password, new_password },
      { silent: true }
    );
  },

  /* ── 存储 ───────────────────────────────────── */

  getStore(rev) {
    const q = rev === undefined || rev === null ? "" : buildQuery({ rev });
    return request("GET", `/api/store${q}`);
  },

  createFolder({ name, parent_id = null }) {
    return request("POST", "/api/store/folders", { name, parent_id });
  },

  updateFolder(fid, patch) {
    return request(
      "PATCH",
      `/api/store/folders/${encodeURIComponent(fid)}`,
      patch || {}
    );
  },

  deleteFolder(fid, { cascade = false } = {}) {
    return request(
      "DELETE",
      `/api/store/folders/${encodeURIComponent(fid)}${buildQuery({
        cascade: cascade ? "true" : "false",
      })}`
    );
  },

  createItem({ title, content, folder_id = null }) {
    return request("POST", "/api/store/items", { title, content, folder_id });
  },

  updateItem(iid, patch) {
    return request(
      "PATCH",
      `/api/store/items/${encodeURIComponent(iid)}`,
      patch || {}
    );
  },

  deleteItem(iid) {
    return request("DELETE", `/api/store/items/${encodeURIComponent(iid)}`);
  },

  /* ── 分享 ───────────────────────────────────── */

  shareDirect({ to, kind, id }) {
    return request("POST", "/api/share/direct", { to, kind, id });
  },

  getInbox() {
    return request("GET", "/api/share/inbox");
  },

  acceptShare(sid, { folder_id = null } = {}) {
    return request(
      "POST",
      `/api/share/inbox/${encodeURIComponent(sid)}/accept`,
      { folder_id }
    );
  },

  deleteInboxShare(sid) {
    return request("DELETE", `/api/share/inbox/${encodeURIComponent(sid)}`);
  },

  getOutbox() {
    return request("GET", "/api/share/outbox");
  },

  revokeOutboxShare(sid) {
    return request("DELETE", `/api/share/outbox/${encodeURIComponent(sid)}`);
  },

  createLink({ kind, id, expires_in = null }) {
    return request("POST", "/api/share/link", { kind, id, expires_in });
  },

  getLinks() {
    return request("GET", "/api/share/links");
  },

  deleteLink(token) {
    return request("DELETE", `/api/share/links/${encodeURIComponent(token)}`);
  },

  // 免认证：公开分享页用，401/404 都不该影响本地登录态
  getPublic(token) {
    return request("GET", `/api/public/${encodeURIComponent(token)}`, undefined, {
      auth: false,
      silent: true,
    });
  },

  /* ── 管理员 ─────────────────────────────────── */

  adminInvite() {
    return request("GET", "/api/admin/invite");
  },

  adminGetSettings() {
    return request("GET", "/api/admin/settings");
  },

  adminSetSettings(patch) {
    return request("PATCH", "/api/admin/settings", patch || {});
  },

  adminListUsers() {
    return request("GET", "/api/admin/users");
  },

  adminUpdateUser(username, patch) {
    return request(
      "PATCH",
      `/api/admin/users/${encodeURIComponent(username)}`,
      patch || {}
    );
  },

  adminResetPassword(username) {
    return request(
      "POST",
      `/api/admin/users/${encodeURIComponent(username)}/reset_password`,
      {}
    );
  },

  adminDeleteUser(username) {
    // 204 无响应体
    return request("DELETE", `/api/admin/users/${encodeURIComponent(username)}`);
  },
};

export default api;
