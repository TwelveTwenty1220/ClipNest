# ClipNest — 设计文档

跨设备文本剪贴板。在一台设备上粘贴，在另一台设备一键复制。

## 1. 背景与目标

在一台电脑上复制的内容（命令、配置片段、临时文本）需要在另一台电脑上使用，目前靠聊天软件中转，麻烦。
ClipNest 提供一个公网可访问的 Web 页面：登录后写入内容，另一台设备打开同一页面即可一键复制。

**核心约束**

- 功能简单 → 不引入数据库，用文件存储
- 多设备常驻 → 登录态长期有效
- 私有工具 → 注册需邀请码，邀请码时间轮换
- 有社交需求 → 支持把条目/文件夹分享给其他账号，或生成公开只读链接

## 2. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 后端 | Flask + PyJWT | 需求简单，Flask 足够；JWT 免服务端会话存储 |
| 部署 | gunicorn `-w 1 --threads 8` | 单进程避免文件库跨进程写竞争；线程满足并发 |
| 前端 | 原生 HTML/CSS/JS | 无构建步骤，部署即静态文件 |
| 存储 | JSON 文件 + fcntl 锁 + 原子替换 | 数据量小（单用户 ≤2000 条），无需数据库 |
| 环境 | conda env `clipsync` (Python 3.12) | 与 base 隔离 |

## 3. 架构

```
                    ┌──────────────┐
   设备 A 浏览器 ───▶ │              │
                    │  HTTPS 入口  │ ──▶ gunicorn 127.0.0.1:<PORT>
   设备 B 浏览器 ───▶ │  （反向代理）│         │
                    └──────────────┘         │
                                             ▼
                                    ┌─────────────────┐
                                    │  Flask app      │
                                    │  ┌───────────┐  │
                                    │  │ api/auth  │  │
                                    │  │ api/store │  │
                                    │  │ api/share │  │
                                    │  │ api/admin │  │
                                    │  └─────┬─────┘  │
                                    │        ▼        │
                                    │   storage.py    │  ← fcntl 锁 + 原子替换
                                    └────────┬────────┘
                                             ▼
                                       data/*.json
```

### 模块职责

| 模块 | 职责 | 依赖 |
|---|---|---|
| `app/config.py` | 配置加载、密钥自举（首次启动生成并落盘）、管理员初始化 | — |
| `app/storage.py` | 文件数据库：加锁、原子读写、用户/条目/分享的数据访问 | config |
| `app/security.py` | scrypt 密码哈希、JWT 签发与校验、`@require_auth` / `@require_admin` | config, storage |
| `app/invite.py` | 基于 HMAC 时间窗的邀请码生成与校验 | config |
| `app/errors.py` | `ApiError` 异常类型与统一 JSON 错误处理器 | — |
| `app/validators.py` | 输入校验函数与限额常量 | errors |
| `app/api/auth.py` | 注册、登录、当前用户、改密码 | security, storage, invite, validators |
| `app/api/store.py` | 文件夹树与条目的 CRUD、增量拉取 | security, storage, validators |
| `app/api/share.py` | 定向分享收发、公开链接签发与撤销 | security, storage, validators |
| `app/api/admin.py` | 邀请码查看、注册开关、用户管理 | security, storage, invite |
| `app/web.py` | 页面路由 `/`、`/s/<token>` | — |
| `static/`, `templates/` | 前端单页 + 公开分享只读页 | API 契约 |

**依赖方向单一向下**：`api/* → security/validators → storage → config`。`api/*` 之间互不引用。

## 4. 数据模型

见 `docs/API.md` 第 2 节（数据结构）与第 8 节（存储布局）。要点：

- 用户名 → `uid`（UUID4）映射存于 `users.json`；用户数据目录以 `uid` 命名，避免用户名做路径带来的注入风险
- 每个用户的 `store.json` 带单调递增 `rev`，任何写操作 `rev += 1`
- 前端轮询携带本地 `rev`，服务端未变化则只回 `{"changed": false}`，不传数据

## 5. 关键机制

### 5.1 并发写安全

所有写入走同一条路径：

1. `fcntl.flock(LOCK_EX)` 锁住目标文件的 `.lock` 伴生文件
2. 读取当前 JSON → 在内存修改
3. 写入同目录临时文件 → `os.fsync` → `os.replace()` 原子替换
4. 释放锁

gunicorn 单进程多线程 + fcntl 锁，保证同一时刻只有一个写者；即使进程被强杀，也不会留下半截文件。

### 5.2 认证与失效

JWT HS256，payload：

```json
{ "uid": "...", "username": "...", "role": "user", "tv": 3, "exp": 1234567890 }
```

有效期 30 天，存 `localStorage`。`tv` 是用户记录里的 `token_version`：

- 用户改密码 → `token_version += 1`
- 管理员禁用用户 / 重置密码 → `token_version += 1`

校验时比对 payload 的 `tv` 与用户当前 `token_version`，不一致直接 401。这样长期 token 也有可靠的作废手段。

### 5.3 邀请码（时间轮换）

```
window = floor(unix_time / 600)
code   = base32(hmac_sha256(invite_secret, str(window)))[:8].upper()
```

- 每 10 分钟自动更换，无需存储，重启不影响
- 管理员页显示当前码 + 剩余秒数
- 校验时同时接受**当前窗口与上一个窗口**，避免用户在切换瞬间提交而失败
- 字符集去掉易混淆的 `0/O/1/I`（Crockford Base32 变体）

### 5.4 分享

**定向分享**（快照语义）

发送时对条目或文件夹子树做深拷贝，写入接收方的 `inbox.json`。发送方之后的修改不影响已发出的副本。接收方可以：

- 直接一键复制（不落地）
- "存入我的" → 在自己选定的文件夹下重建条目/子树，此时标记 `accepted_at`
- 忽略删除

发送方在"我发出的"里可以撤回；已被接收（`accepted_at` 非空）的不再可撤回——对方的副本已经是他自己的数据了。

**公开链接**

生成 32 字节 URL-safe 随机 token，快照写入 `data/shares/<token>.json`。`/s/<token>` 免登录只读渲染，带一键复制。可设过期时间，也可随时撤销（删除文件）。

### 5.5 越权防护

`api/store.py` 与 `api/share.py` 的每个资源操作都在当前 `uid` 的数据文件内查找目标 id。找不到即返回 **404**（而非 403），不泄露资源是否存在。

## 6. 前端

### 布局

```
┌──────────────┬────────────────────────────┐
│ 📁 全部       │  ┌──────────────────────┐  │
│ ▾ 项目        │  │ 部署命令          📋 │  │
│   📁 配置     │  │ npm run deploy --prod│  │
│   📁 脚本     │  └──────────────────────┘  │
│ ▸ 工作        │  ┌──────────────────────┐  │
│ 📁 临时       │  │ 备用数据库        📋 │  │
│ 📥 收到的分享 │  │ psql -h db.internal  │  │
│ + 新建文件夹  │  └──────────────────────┘  │
└──────────────┴────────────────────────────┘
```

### 配色（Claude Code 风格）

| 用途 | 深色 | 浅色 |
|---|---|---|
| 页面底 | `#1F1E1D` | `#FAF9F5` |
| 卡片/面板 | `#262624` | `#FFFFFF` |
| 边框 | `#3A3937` | `#E5E2DA` |
| 主文字 | `#F0EEE6` | `#2B2A27` |
| 次文字 | `#9B9891` | `#6B6862` |
| 主色（赤陶） | `#D97757` | `#C15F3C` |
| 成功（复制反馈） | `#7FB069` | `#5C8F4A` |

内容区使用等宽字体（`ui-monospace, "SF Mono", Menlo, Consolas`）——配置片段这类内容更易读。跟随系统 `prefers-color-scheme`，并提供手动切换（存 `localStorage`）。

### 同步

- 每 4 秒 `GET /api/store?rev=N`；`document.hidden` 时暂停轮询，恢复可见时立即拉一次
- 本地写操作后立即用返回的 `rev` 更新，避免自己的改动被下一次轮询回滚

### 复制

`navigator.clipboard.writeText()`；失败降级到隐藏 `<textarea>` + `document.execCommand('copy')`。成功后按钮短暂变为绿色勾。

## 7. 安全

- 密码：`hashlib.scrypt`（n=16384, r=8, p=1），每用户独立 16 字节盐
- 密钥：`jwt_secret` 与 `invite_secret` 首次启动用 `secrets.token_bytes(32)` 生成，写入 `data/config.json`（已在 `.gitignore` 中）
- 初始管理员 `1220` 的随机密码打印到控制台并写入 `data/ADMIN_PASSWORD.txt`，提示用户保存后删除
- 登录接口按用户名做简单限流（内存计数，5 次失败后锁定 60 秒）
- 所有响应带 `X-Content-Type-Options: nosniff`；公开分享页对内容做 HTML 转义
- **仓库中不出现任何真实密钥、密码、token**；文档与示例一律用 `***` 占位

## 8. 限额

| 项 | 上限 |
|---|---|
| 单条内容 | 100,000 字符 |
| 标题 | 200 字符 |
| 文件夹名 | 60 字符 |
| 每用户条目数 | 2,000 |
| 每用户文件夹数 | 200 |
| 文件夹树深度 | 8 |
| 收件箱条数 | 200 |
| 公开链接数 | 100 |

超限返回 `409 quota_exceeded`。

## 9. 测试

pytest，每个 API 模块一个测试文件，共享 `tests/conftest.py`（临时数据目录 + 测试客户端 + 已认证客户端 fixture）。

必须覆盖：

- 注册：邀请码正确/错误/上一窗口仍有效、注册开关关闭、用户名重复（大小写不敏感）
- 登录：成功、密码错误、账号被禁用、改密码后旧 token 失效
- 文件夹：创建、重命名、移动、深度超限、循环父子引用被拒、删除的级联与提升两种行为
- 条目：CRUD、置顶、超限、`rev` 增量语义
- **越权**：用户 A 无法读写用户 B 的任何条目/文件夹（一律 404）
- 分享：定向发送→收件箱→接受落地→撤回边界；公开链接读取、过期、撤销
- 管理员：非管理员访问返回 403；禁用用户后其 token 立即失效；不能删除自己

## 10. 开发与提交

按模块分批提交，顺序：

1. 项目骨架 + 文档 + `.gitignore`
2. 基础设施（config / storage / security / invite / errors / validators / app 工厂）
3. 认证 API + 测试
4. 存储 API（文件夹与条目）+ 测试
5. 分享 API + 测试
6. 管理员 API + 测试
7. 前端页面与样式
8. 部署脚本与 README
