# ClipNest — API 契约

本文件是前后端与各模块之间的**唯一契约**。实现必须严格遵守；如需变更，先改本文件。

---

## 1. 通用约定

- 所有接口前缀 `/api`，请求与响应均为 `application/json; charset=utf-8`
- 除 `POST /api/auth/register`、`POST /api/auth/login`、`GET /api/public/<token>` 外，全部需要认证
- 认证方式：`Authorization: Bearer <jwt>`
- 时间戳统一为 Unix 秒（整数 `int`）
- ID 生成：文件夹 `f_` + 12 位十六进制；条目 `i_` + 12 位十六进制；分享 `s_` + 12 位十六进制

### 1.1 错误响应

所有错误统一格式：

```json
{ "error": { "code": "validation_error", "message": "用户名长度需在 3-32 之间" } }
```

| code | HTTP | 含义 |
|---|---|---|
| `validation_error` | 400 | 请求体字段缺失或不合法 |
| `unauthorized` | 401 | 缺少 / 无效 / 过期 token，或 `tv` 不匹配 |
| `forbidden` | 403 | 已登录但权限不足（非管理员访问管理接口） |
| `not_found` | 404 | 资源不存在，或不属于当前用户 |
| `conflict` | 409 | 用户名已存在、循环父子引用 |
| `quota_exceeded` | 409 | 超出限额 |
| `invalid_invite` | 400 | 邀请码错误或已过期 |
| `registration_closed` | 403 | 注册开关已关闭 |
| `rate_limited` | 429 | 登录失败次数过多 |
| `payload_too_large` | 413 | 请求体超过 2 MB |
| `internal_error` | 500 | 未预期异常 |

后端实现：`app/errors.py` 定义 `ApiError(code, message, status)`，并注册 `errorhandler` 统一序列化。

### 1.2 限额常量（`app/validators.py`）

```python
MAX_CONTENT_LEN   = 100_000
MAX_TITLE_LEN     = 200
MAX_FOLDER_NAME   = 60
MAX_ITEMS         = 2_000
MAX_FOLDERS       = 200
MAX_TREE_DEPTH    = 8
MAX_INBOX         = 200
MAX_LINKS         = 100
MAX_REQUEST_BYTES = 2 * 1024 * 1024

USERNAME_RE   = r"^[A-Za-z0-9_\-]{3,32}$"
MIN_PASSWORD  = 8
DEFAULT_TITLE = "未命名"
```

用户名大小写不敏感唯一：存储时保留原始大小写用于展示，用 `username.lower()` 做唯一键与查找。

---

## 2. 数据结构

### User（对外暴露）

```json
{
  "username": "1220",
  "role": "admin",
  "created_at": 1755100000
}
```

`role` 取值 `"admin"` | `"user"`。密码哈希、盐、`uid`、`token_version` **绝不出现在任何响应中**。

### Folder

```json
{
  "id": "f_a1b2c3d4e5f6",
  "name": "项目",
  "parent_id": null,
  "order": 0,
  "created_at": 1755100000
}
```

`parent_id` 为 `null` 表示根级。`order` 为同级内的排序序号（升序），新建时取同级最大值 +1。

### Item

```json
{
  "id": "i_a1b2c3d4e5f6",
  "folder_id": "f_a1b2c3d4e5f6",
  "title": "部署命令",
  "content": "npm run deploy -- --env prod;z;3;f;0",
  "pinned": false,
  "created_at": 1755100000,
  "updated_at": 1755100000
}
```

`folder_id` 为 `null` 表示根级（未归类）。

### SharePayload

条目分享：

```json
{ "kind": "item", "item": { "title": "...", "content": "..." } }
```

文件夹分享（子树快照，`folders[].parent_id` 用快照内的相对 id，根节点 `parent_id` 为 `null`）：

```json
{
  "kind": "folder",
  "name": "配置",
  "folders": [ { "id": "f_...", "name": "子文件夹", "parent_id": null, "order": 0 } ],
  "items":   [ { "folder_id": null, "title": "...", "content": "...", "pinned": false } ]
}
```

### InboxShare

```json
{
  "id": "s_a1b2c3d4e5f6",
  "from": "someone",
  "payload": { "...SharePayload..." },
  "created_at": 1755100000,
  "accepted_at": null
}
```

### OutboxShare

```json
{
  "id": "s_a1b2c3d4e5f6",
  "to": "someone",
  "kind": "item",
  "summary": "部署命令",
  "created_at": 1755100000,
  "accepted": false
}
```

### PublicLink

```json
{
  "token": "***",
  "url": "/s/***",
  "kind": "item",
  "summary": "部署命令",
  "created_at": 1755100000,
  "expires_at": null
}
```

> 文档中所有真实 token / 密码一律以 `***` 占位，仓库内不得出现真实值。

---

## 3. 认证 `app/api/auth.py` — 前缀 `/api/auth`

### `POST /api/auth/register`

```json
{ "username": "xinkun", "password": "***", "invite_code": "***" }
```

**201** → `{ "token": "***", "user": { ...User } }`

错误：`registration_closed`(403) / `invalid_invite`(400) / `conflict`(409, 用户名已存在) / `validation_error`(400)

### `POST /api/auth/login`

```json
{ "username": "1220", "password": "***" }
```

**200** → `{ "token": "***", "user": { ...User } }`

错误：`unauthorized`(401, 用户名或密码错误 — 两种情况返回同一消息，不区分) / `forbidden`(403, 账号已被禁用) / `rate_limited`(429)

限流：同一用户名连续 5 次失败后锁定 60 秒（进程内内存计数，重启清空，够用）。

### `GET /api/auth/me`

**200** → `{ "user": { ...User } }`

### `POST /api/auth/password`

```json
{ "old_password": "***", "new_password": "***" }
```

**200** → `{ "token": "***" }`（`token_version` 自增，旧 token 全部失效，返回新 token 供当前设备继续使用）

错误：`unauthorized`(401, 旧密码错误) / `validation_error`(400, 新密码过短)

---

## 4. 存储 `app/api/store.py` — 前缀 `/api/store`

### `GET /api/store?rev=<int>`

增量拉取。`rev` 参数可选；不传视为 `-1`（强制全量）。

未变化 **200**：

```json
{ "changed": false, "rev": 42, "inbox_count": 2 }
```

有变化 **200**：

```json
{
  "changed": true,
  "rev": 43,
  "folders": [ { ...Folder } ],
  "items": [ { ...Item } ],
  "inbox_count": 2
}
```

`inbox_count` 为收件箱中未接受（`accepted_at == null`）的分享数量，供前端在侧栏显示红点。

**两条分支都必须带 `inbox_count`**：收到分享只写接收方的 `inbox.json`，不会改动其 `store.json` 的 `rev`。若只在 `changed: true` 时下发，未读角标就永远不会亮。

### `POST /api/store/folders`

```json
{ "name": "项目", "parent_id": null }
```

**201** → `{ "folder": { ...Folder }, "rev": 44 }`

错误：`validation_error`(400, 名称为空/超长) / `not_found`(404, `parent_id` 不存在) / `quota_exceeded`(409, 超过 `MAX_FOLDERS` 或深度超过 `MAX_TREE_DEPTH`)

### `PATCH /api/store/folders/<fid>`

```json
{ "name": "项目2", "parent_id": "f_...", "order": 3 }
```

三个字段均可选，只更新传入的。**200** → `{ "folder": { ...Folder }, "rev": 45 }`

错误：`not_found`(404) / `conflict`(409, `parent_id` 指向自身或自己的后代 — 会形成环) / `quota_exceeded`(409, 移动后子树深度超限)

### `DELETE /api/store/folders/<fid>?cascade=<bool>`

- `cascade=false`（默认）：子文件夹与直属条目**提升**到被删文件夹的父级
- `cascade=true`：递归删除整个子树及其中全部条目

**200** → `{ "rev": 46, "deleted_items": 3, "deleted_folders": 2 }`

### `POST /api/store/items`

```json
{ "title": "部署命令", "content": "PORT=8420;...", "folder_id": null }
```

`title` 可省略或为空串 → 使用 `DEFAULT_TITLE`（`"未命名"`）。`content` 必填，可以是空串。

**201** → `{ "item": { ...Item }, "rev": 47 }`

错误：`validation_error`(400) / `not_found`(404, `folder_id` 不存在) / `quota_exceeded`(409)

### `PATCH /api/store/items/<iid>`

```json
{ "title": "...", "content": "...", "folder_id": "f_...", "pinned": true }
```

四个字段均可选。任一字段变更都会刷新 `updated_at`。**200** → `{ "item": { ...Item }, "rev": 48 }`

### `DELETE /api/store/items/<iid>`

**200** → `{ "rev": 49 }`

---

## 5. 分享 `app/api/share.py` — 前缀 `/api/share`

### `POST /api/share/direct`

```json
{ "to": "someone", "kind": "item", "id": "i_..." }
```

`kind` ∈ `"item"` | `"folder"`。对目标做深拷贝快照写入接收方 `inbox.json`，同时在发送方 `outbox.json` 记录。

**201** → `{ "share": { ...OutboxShare } }`

错误：`not_found`(404, 目标用户不存在 / 自己的资源 id 不存在) / `validation_error`(400, 分享给自己) / `quota_exceeded`(409, 对方收件箱已满)

### `GET /api/share/inbox`

**200** → `{ "shares": [ { ...InboxShare } ] }`（按 `created_at` 倒序）

### `POST /api/share/inbox/<sid>/accept`

```json
{ "folder_id": null }
```

把快照落地到当前用户的存储：`kind=item` 新建一条条目；`kind=folder` 在 `folder_id` 下重建整棵子树。落地后标记 `accepted_at`，**分享仍保留在收件箱**（用户可自行删除）。

**200** → `{ "rev": 50, "created_items": 5, "created_folders": 2 }`

错误：`not_found`(404) / `quota_exceeded`(409, 落地后超出条目或文件夹限额)

### `DELETE /api/share/inbox/<sid>`

从收件箱移除（忽略）。**200** → `{ "ok": true }`

### `GET /api/share/outbox`

**200** → `{ "shares": [ { ...OutboxShare } ] }`（按 `created_at` 倒序）

### `DELETE /api/share/outbox/<sid>`

撤回：同时从接收方收件箱删除。仅当接收方**尚未接受**（`accepted_at == null`）时生效。

**200** → `{ "ok": true }`
错误：`conflict`(409, 对方已接受，不可撤回) / `not_found`(404)

### `POST /api/share/link`

```json
{ "kind": "item", "id": "i_...", "expires_in": 86400 }
```

`expires_in` 可选，单位秒；省略或 `null` 表示永不过期。

**201** → `{ "link": { ...PublicLink } }`

错误：`not_found`(404) / `quota_exceeded`(409, 超过 `MAX_LINKS`)

### `GET /api/share/links`

**200** → `{ "links": [ { ...PublicLink } ] }`

### `DELETE /api/share/links/<token>`

撤销公开链接（删除快照文件）。**200** → `{ "ok": true }`

### `GET /api/public/<token>` — **免认证**

注意此接口挂在 `/api/public`，不在 `/api/share` 下。

**200** → `{ "payload": { ...SharePayload }, "created_at": 1755100000, "expires_at": null }`

错误：`not_found`(404, token 不存在、已撤销或已过期 — 一律 404，不区分)

---

## 6. 管理员 `app/api/admin.py` — 前缀 `/api/admin`

所有接口要求 `role == "admin"`，否则 **403 `forbidden`**。

### `GET /api/admin/invite`

**200** → `{ "code": "***", "expires_in": 342, "period": 600 }`

`expires_in` 为当前码剩余有效秒数。

### `GET /api/admin/settings`

**200** → `{ "registration_open": false }`

### `PATCH /api/admin/settings`

```json
{ "registration_open": true }
```

**200** → `{ "registration_open": true }`

### `GET /api/admin/users`

**200**：

```json
{
  "users": [
    {
      "username": "1220",
      "role": "admin",
      "created_at": 1755100000,
      "disabled": false,
      "item_count": 12,
      "folder_count": 3
    }
  ]
}
```

### `PATCH /api/admin/users/<username>`

```json
{ "disabled": true }
```

禁用时 `token_version += 1`，该用户所有已签发 token 立即失效。

**200** → `{ "user": { ...AdminUser } }`
错误：`not_found`(404) / `forbidden`(403, 不能禁用自己)

### `POST /api/admin/users/<username>/reset_password`

生成 16 位随机密码，写入用户记录并自增 `token_version`。**新密码仅在本次响应中返回一次**。

**200** → `{ "password": "***" }`
错误：`not_found`(404)

### `DELETE /api/admin/users/<username>`

删除用户及其全部数据目录，并清理其发出的公开链接与他人收件箱中来自该用户的分享。

**204** 无响应体
错误：`not_found`(404) / `forbidden`(403, 不能删除自己)

---

## 7. 页面路由 `app/web.py`

| 路由 | 说明 |
|---|---|
| `GET /` | 主应用单页（`templates/index.html`）。未登录时前端自行渲染登录/注册界面 |
| `GET /s/<token>` | 公开分享只读页（`templates/share.html`），免认证，页面内用 `GET /api/public/<token>` 取数据 |
| `GET /healthz` | `{"ok": true}`，供隧道健康检查 |

---

## 8. 存储布局

```
data/
├── config.json                  # jwt_secret / invite_secret / registration_open   ← 含密钥，永不入库
├── users.json                   # 用户表
├── users/
│   └── <uid>/
│       ├── store.json           # folders / items / rev
│       ├── inbox.json           # 收到的分享
│       └── outbox.json          # 发出的分享
└── shares/
    └── <token>.json             # 公开链接快照
```

### `config.json`

```json
{
  "jwt_secret": "***",
  "invite_secret": "***",
  "registration_open": false,
  "initialized_at": 1755100000
}
```

### `users.json`

```json
{
  "users": {
    "1220": {
      "uid": "3f2a...",
      "username": "1220",
      "pwd_salt": "***",
      "pwd_hash": "***",
      "role": "admin",
      "created_at": 1755100000,
      "disabled": false,
      "token_version": 1
    }
  }
}
```

顶层 key 为 `username.lower()`；`username` 字段保留原始大小写用于展示。

### `users/<uid>/store.json`

```json
{ "rev": 42, "folders": [], "items": [] }
```

### `users/<uid>/inbox.json`

```json
{ "shares": [ { ...InboxShare, "from_uid": "..." } ] }
```

### `users/<uid>/outbox.json`

```json
{ "shares": [ { ...OutboxShare, "to_uid": "...", "share_id": "s_..." } ] }
```

`share_id` 与接收方收件箱中的 `id` 相同，用于撤回时定位。

### `shares/<token>.json`

```json
{
  "token": "***",
  "owner_uid": "...",
  "kind": "item",
  "summary": "部署命令",
  "payload": { "...SharePayload..." },
  "created_at": 1755100000,
  "expires_at": null
}
```

---

## 9. `app/storage.py` 提供的函数（各 API 模块只通过这些函数访问数据）

```python
# ── 底层 ──────────────────────────────────────────────
def read_json(path: Path, default: Any) -> Any: ...
def write_json_atomic(path: Path, data: Any) -> None: ...

@contextmanager
def locked(path: Path):
    """对 path 加排他锁；with 块内可安全读改写。"""

@contextmanager
def mutate_json(path: Path, default: Any):
    """加锁 → 读取 → yield 可变对象 → 原子写回。异常时不写回。"""

# ── 用户 ──────────────────────────────────────────────
def load_users() -> dict: ...
def get_user(username: str) -> dict | None:      # 大小写不敏感
def get_user_by_uid(uid: str) -> dict | None: ...
def create_user(username, pwd_salt, pwd_hash, role="user") -> dict: ...   # conflict 时抛 ApiError
def update_user(username: str, **fields) -> dict: ...                     # 自动落盘
def bump_token_version(username: str) -> int: ...
def delete_user(username: str) -> None: ...                               # 连同数据目录
def list_users() -> list[dict]: ...

# ── 用户存储 ──────────────────────────────────────────
def user_dir(uid: str) -> Path: ...
def load_store(uid: str) -> dict: ...
@contextmanager
def mutate_store(uid: str):
    """yield store dict；退出时 rev += 1 并原子写回。"""

def load_inbox(uid: str) -> dict: ...
@contextmanager
def mutate_inbox(uid: str): ...

def load_outbox(uid: str) -> dict: ...
@contextmanager
def mutate_outbox(uid: str): ...

# ── 公开链接 ──────────────────────────────────────────
def link_path(token: str) -> Path: ...        # token 必须先经过字符集校验
def load_link(token: str) -> dict | None: ...
def save_link(token: str, data: dict) -> None: ...
def delete_link(token: str) -> bool: ...
def list_links(owner_uid: str) -> list[dict]: ...

# ── ID ────────────────────────────────────────────────
def new_id(prefix: str) -> str:   # f"{prefix}_{secrets.token_hex(6)}"
```

**注意**：`mutate_store` 退出时自动 `rev += 1`。如果本次操作实际未修改任何数据，调用方应在 `with` 块内 `raise storage.NoChange`（该异常被 `mutate_store` 吞掉且不写回、不递增 `rev`）。

---

## 10. `app/security.py` 提供的函数

```python
def hash_password(password: str) -> tuple[str, str]:
    """返回 (salt_hex, hash_hex)，scrypt n=16384 r=8 p=1，盐 16 字节。"""

def verify_password(password: str, salt_hex: str, hash_hex: str) -> bool:
    """常数时间比较。"""

def issue_token(user: dict) -> str:
    """HS256，payload {uid, username, role, tv, exp}，exp = now + 30 天。"""

def decode_token(token: str) -> dict:
    """解码并校验签名与 exp；失败抛 ApiError('unauthorized')。不校验 tv。"""

def require_auth(fn):
    """装饰器：解析 Bearer token → 校验 tv 与 disabled → 注入 flask.g.user（完整用户记录，含 uid）。"""

def require_admin(fn):
    """装饰器：先 require_auth，再校验 role == 'admin'，否则 403。"""
```

`flask.g.user` 是 `users.json` 中的完整记录（含 `uid`、`token_version` 等），API 模块通过 `g.user["uid"]` 定位数据目录。

---

## 11. `app/invite.py` 提供的函数

```python
INVITE_PERIOD = 600          # 秒
INVITE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"   # Crockford Base32，去掉 I L O U
INVITE_LEN = 8

def current_code() -> str: ...
def code_expires_in() -> int:
    """当前码剩余有效秒数。"""
def verify_code(code: str) -> bool:
    """接受当前窗口与上一窗口；大小写不敏感；去除空格与连字符后比较。"""
```

---

## 12. 前端调用约定（`static/js/api.js`）

```js
// token 存 localStorage，key = "clipnest_token"
// 所有请求自动带 Authorization 头
// 收到 401 → 清除 token 并跳转登录界面
api.register({username, password, invite_code})
api.login({username, password})
api.me()
api.changePassword({old_password, new_password})

api.getStore(rev)                       // → {changed, rev, folders?, items?, inbox_count?}
api.createFolder({name, parent_id})
api.updateFolder(fid, patch)
api.deleteFolder(fid, {cascade})
api.createItem({title, content, folder_id})
api.updateItem(iid, patch)
api.deleteItem(iid)

api.shareDirect({to, kind, id})
api.getInbox()
api.acceptShare(sid, {folder_id})
api.deleteInboxShare(sid)
api.getOutbox()
api.revokeOutboxShare(sid)
api.createLink({kind, id, expires_in})
api.getLinks()
api.deleteLink(token)
api.getPublic(token)                    // 免认证

api.adminInvite()
api.adminGetSettings()
api.adminSetSettings(patch)
api.adminListUsers()
api.adminUpdateUser(username, patch)
api.adminResetPassword(username)
api.adminDeleteUser(username)
```
