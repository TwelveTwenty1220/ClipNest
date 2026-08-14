"""路径与运行参数。

这里只做路径解析，不碰文件 IO —— 避免与 storage 形成循环依赖。
全部以函数形式暴露（而非模块级常量），这样测试里改 CLIPNEST_DATA_DIR
环境变量就能立刻生效，不受模块导入缓存影响。
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _resolve(env_name: str, default: str) -> Path:
    raw = os.environ.get(env_name) or default
    path = Path(raw).expanduser()
    return path if path.is_absolute() else BASE_DIR / path


def data_dir() -> Path:
    return _resolve("CLIPNEST_DATA_DIR", "data")


def config_path() -> Path:
    return data_dir() / "config.json"


def users_path() -> Path:
    return data_dir() / "users.json"


def users_dir() -> Path:
    return data_dir() / "users"


def shares_dir() -> Path:
    return data_dir() / "shares"


def admin_password_path() -> Path:
    return data_dir() / "ADMIN_PASSWORD.txt"


def admin_username() -> str:
    return os.environ.get("CLIPNEST_ADMIN_USERNAME", "1220")


def token_days() -> int:
    try:
        return max(1, int(os.environ.get("CLIPNEST_TOKEN_DAYS", "30")))
    except ValueError:
        return 30


def host() -> str:
    return os.environ.get("CLIPNEST_HOST", "127.0.0.1")


def port() -> int:
    try:
        return int(os.environ.get("CLIPNEST_PORT", "8420"))
    except ValueError:
        return 8420
