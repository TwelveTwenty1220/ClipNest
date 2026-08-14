"""首次启动自举：建目录、生成密钥、创建初始管理员。

幂等 —— 每次启动都会调用，已存在的东西不会被覆盖或重新生成。
"""

import os
import secrets
import stat

from app import config, security, storage


def bootstrap(*, verbose: bool = True) -> None:
    storage.ensure_dirs()
    _ensure_secrets()
    _ensure_admin(verbose=verbose)


def _ensure_secrets() -> None:
    with storage.mutate_app_config() as cfg:
        changed = False
        for name in ("jwt_secret", "invite_secret"):
            if not cfg.get(name):
                cfg[name] = secrets.token_hex(32)
                changed = True
        if "registration_open" not in cfg:
            cfg["registration_open"] = False
            changed = True
        if "initialized_at" not in cfg:
            cfg["initialized_at"] = storage.now()
            changed = True
        if not changed:
            raise storage.NoChange
    _chmod_600(config.config_path())


def _ensure_admin(*, verbose: bool) -> None:
    username = config.admin_username()
    if storage.get_user(username) is not None:
        return

    password = security.random_password(24)
    salt, digest = security.hash_password(password)
    storage.create_user(username, salt, digest, role="admin")

    path = config.admin_password_path()
    path.write_text(
        "ClipNest 初始管理员账号\n"
        f"用户名: {username}\n"
        f"密  码: {password}\n\n"
        "请把密码保存到密码管理器，然后删除本文件。\n"
        "（data/ 已在 .gitignore 中，不会被提交）\n",
        encoding="utf-8",
    )
    _chmod_600(path)

    if verbose:
        print("=" * 60, flush=True)
        print("  ClipNest 已初始化管理员账号", flush=True)
        print(f"  用户名: {username}", flush=True)
        print(f"  密  码: {password}", flush=True)
        print(f"  已同时写入: {path}", flush=True)
        print("  保存到密码管理器后请删除该文件。", flush=True)
        print("=" * 60, flush=True)


def _chmod_600(path) -> None:
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
