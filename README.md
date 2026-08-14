# ClipNest

跨设备文本剪贴板。在一台设备粘贴，在另一台设备一键复制。

不用再把命令、配置片段、临时文本发给自己的微信，再到另一台电脑上登录一遍了。

## 功能

- 🔐 邀请码注册 + JWT 登录，多设备常驻 30 天
- 📁 多层文件夹，像文件管理器一样组织内容（`项目 / 配置 / ...`）
- 📋 一键复制，卡片右上角点一下就进剪贴板
- 🔍 跨文件夹搜索、置顶常用条目
- 🔄 自动轮询同步，一边保存另一边几秒内出现
- 🤝 分享给指定账号（对方可选择存入自己的库），或生成公开只读链接
- 🛠 管理员面板：动态邀请码、注册开关、用户管理
- 🎨 Claude Code 风格配色，深色 / 浅色双主题

## 技术栈

Flask + PyJWT，文件即数据库（JSON + fcntl 锁 + 原子替换），原生前端无构建步骤。

## 快速开始

```bash
# 1. 创建环境
conda create -n clipsync python=3.12 -y
conda activate clipsync
pip install -r requirements.txt

# 2. 启动
./run.sh
```

首次启动会自动：

- 生成 `data/config.json`（内含 JWT 与邀请码密钥）
- 创建管理员账号 `1220`，随机密码打印到控制台并写入 `data/ADMIN_PASSWORD.txt`

> ⚠️ 把管理员密码保存到密码管理器后，删掉 `data/ADMIN_PASSWORD.txt`。
> `data/` 整个目录已在 `.gitignore` 中，不会进仓库。

## 公网访问

通过 cloudflared 命名隧道暴露到自有域名：

```bash
cloudflared tunnel create clipnest
cloudflared tunnel route dns clipnest <your-domain>
cloudflared tunnel run --url http://localhost:8420 clipnest
```

线上地址：<https://<your-domain>>

HTTPS 是必需的——浏览器的 `navigator.clipboard` API 只在安全上下文（`isSecureContext === true`）可用。走 http 时前端会自动降级到 `textarea` + `execCommand`，但体验不如原生。

## 文档

- [设计文档](docs/DESIGN.md) — 架构、模块划分、关键机制
- [API 契约](docs/API.md) — 完整接口定义与数据结构

## 测试

```bash
pytest
```

## 安全说明

仓库内不包含任何真实密钥、密码或 token。所有敏感值在运行时生成并写入 `data/`（已忽略），文档中一律以 `***` 占位。
