"""输入校验与限额常量。见 docs/API.md 1.2 节。"""

import re

from app.errors import bad_request

MAX_CONTENT_LEN = 100_000
MAX_TITLE_LEN = 200
MAX_FOLDER_NAME = 60
MAX_ITEMS = 2_000
MAX_FOLDERS = 200
MAX_TREE_DEPTH = 8
MAX_INBOX = 200
MAX_LINKS = 100
MAX_REQUEST_BYTES = 2 * 1024 * 1024

USERNAME_RE = re.compile(r"^[A-Za-z0-9_\-]{3,32}$")
MIN_PASSWORD = 8
DEFAULT_TITLE = "未命名"


def body(payload) -> dict:
    """把 request.get_json(silent=True) 的结果规整成 dict。"""
    if payload is None:
        return {}
    if not isinstance(payload, dict):
        raise bad_request("请求体必须是 JSON 对象")
    return payload


def require_str(data: dict, key: str, *, max_len: int, min_len: int = 1, label: str | None = None) -> str:
    label = label or key
    value = data.get(key)
    if not isinstance(value, str):
        raise bad_request(f"{label} 必填")
    value = value.strip()
    if len(value) < min_len:
        raise bad_request(f"{label} 不能为空")
    if len(value) > max_len:
        raise bad_request(f"{label} 长度不能超过 {max_len}")
    return value


def optional_str(data: dict, key: str, *, max_len: int, label: str | None = None) -> str | None:
    """字段不存在返回 None；存在则校验类型与长度（允许空串）。"""
    if key not in data:
        return None
    label = label or key
    value = data.get(key)
    if value is None:
        return ""
    if not isinstance(value, str):
        raise bad_request(f"{label} 必须是字符串")
    if len(value) > max_len:
        raise bad_request(f"{label} 长度不能超过 {max_len}")
    return value


def optional_bool(data: dict, key: str, label: str | None = None) -> bool | None:
    if key not in data:
        return None
    value = data.get(key)
    if not isinstance(value, bool):
        raise bad_request(f"{label or key} 必须是布尔值")
    return value


def optional_int(data: dict, key: str, *, minimum: int | None = None, label: str | None = None) -> int | None:
    if key not in data or data.get(key) is None:
        return None
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise bad_request(f"{label or key} 必须是整数")
    if minimum is not None and value < minimum:
        raise bad_request(f"{label or key} 不能小于 {minimum}")
    return value


def optional_id(data: dict, key: str, prefix: str, label: str | None = None) -> tuple[bool, str | None]:
    """返回 (字段是否出现, 值)。值为 None 表示显式置空（移到根级）。"""
    if key not in data:
        return False, None
    value = data.get(key)
    if value is None:
        return True, None
    if not isinstance(value, str) or not value.startswith(f"{prefix}_"):
        raise bad_request(f"{label or key} 不合法")
    return True, value


def validate_username(raw) -> str:
    if not isinstance(raw, str):
        raise bad_request("用户名必填")
    name = raw.strip()
    if not USERNAME_RE.match(name):
        raise bad_request("用户名需为 3-32 位字母、数字、下划线或连字符")
    return name


def validate_password(raw, label: str = "密码") -> str:
    if not isinstance(raw, str):
        raise bad_request(f"{label}必填")
    if len(raw) < MIN_PASSWORD:
        raise bad_request(f"{label}至少 {MIN_PASSWORD} 位")
    if len(raw) > 256:
        raise bad_request(f"{label}过长")
    return raw


def validate_content(raw) -> str:
    if raw is None:
        return ""
    if not isinstance(raw, str):
        raise bad_request("内容必须是字符串")
    if len(raw) > MAX_CONTENT_LEN:
        raise bad_request(f"内容长度不能超过 {MAX_CONTENT_LEN} 字符")
    return raw


def normalize_title(raw) -> str:
    """空标题回落到默认标题。"""
    if not isinstance(raw, str):
        return DEFAULT_TITLE
    title = raw.strip()
    if not title:
        return DEFAULT_TITLE
    if len(title) > MAX_TITLE_LEN:
        raise bad_request(f"标题长度不能超过 {MAX_TITLE_LEN} 字符")
    return title


def validate_folder_name(raw) -> str:
    return require_str({"name": raw}, "name", max_len=MAX_FOLDER_NAME, label="文件夹名")


def validate_kind(raw) -> str:
    if raw not in ("item", "folder"):
        raise bad_request("kind 必须是 item 或 folder")
    return raw
