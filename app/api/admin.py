"""管理员 API —— 见 docs/API.md 第 6 节。"""

from flask import Blueprint, g, jsonify, request

from app import invite, security, storage, validators
from app.errors import bad_request, forbidden, not_found

bp = Blueprint("admin", __name__, url_prefix="/api/admin")


# ── 视图与公共校验 ────────────────────────────────────────

def _admin_view(record: dict) -> dict:
    """管理员视角的用户信息。

    比 public_user 多出禁用状态与数据量，但同样绝不带 uid / 密码哈希 /
    token_version —— users.json 里的原始记录任何时候都不能直接进响应。
    """
    view = storage.public_user(record)
    view["disabled"] = bool(record.get("disabled", False))
    uid = record.get("uid") or ""
    # 理论上每个用户都有数据目录；真缺了也只是计数为 0，不该让整个列表接口挂掉
    store = storage.load_store(uid) if uid else dict(storage.DEFAULT_STORE)
    view["item_count"] = len(store.get("items", []))
    view["folder_count"] = len(store.get("folders", []))
    return view


def _require_user(username: str) -> dict:
    record = storage.get_user(username)
    if record is None:
        raise not_found("用户不存在")
    return record


def _deny_self(record: dict, action: str) -> None:
    """管理员对自己动手会把自己锁在门外，一律拒绝。用户名大小写不敏感。"""
    mine = (g.user.get("username") or "").lower()
    if (record.get("username") or "").lower() == mine:
        raise forbidden(f"不能{action}自己")


# ── 邀请码 ───────────────────────────────────────────────

@bp.get("/invite")
@security.require_admin
def get_invite():
    return jsonify({
        "code": invite.current_code(),
        "expires_in": invite.code_expires_in(),
        "period": invite.INVITE_PERIOD,
    })


# ── 注册开关 ─────────────────────────────────────────────

@bp.get("/settings")
@security.require_admin
def get_settings():
    return jsonify({"registration_open": bool(storage.load_app_config().get("registration_open", False))})


@bp.patch("/settings")
@security.require_admin
def update_settings():
    data = validators.body(request.get_json(silent=True))
    value = validators.optional_bool(data, "registration_open")
    if value is None:
        raise bad_request("registration_open 必填")
    with storage.mutate_app_config() as cfg:
        cfg["registration_open"] = value
    return jsonify({"registration_open": value})


# ── 用户管理 ─────────────────────────────────────────────

@bp.get("/users")
@security.require_admin
def list_users():
    return jsonify({"users": [_admin_view(record) for record in storage.list_users()]})


@bp.patch("/users/<username>")
@security.require_admin
def update_user(username: str):
    data = validators.body(request.get_json(silent=True))
    disabled = validators.optional_bool(data, "disabled")
    if disabled is None:
        raise bad_request("disabled 必填")

    record = _require_user(username)
    _deny_self(record, "禁用")

    updated = storage.update_user(record["username"], disabled=disabled)
    # 解禁时同样自增：行为一致好解释，代价只是让对方重新登录一次
    # （users.json 的锁不可重入，必须在 update_user 之后单独调用）
    storage.bump_token_version(record["username"])
    return jsonify({"user": _admin_view(updated)})


@bp.post("/users/<username>/reset_password")
@security.require_admin
def reset_password(username: str):
    record = _require_user(username)
    password = security.random_password(16)
    salt, digest = security.hash_password(password)
    storage.update_user(record["username"], pwd_salt=salt, pwd_hash=digest)
    storage.bump_token_version(record["username"])
    # 明文只在这一次响应里出现，不写日志、不落盘
    return jsonify({"password": password})


@bp.delete("/users/<username>")
@security.require_admin
def delete_user(username: str):
    record = _require_user(username)
    _deny_self(record, "删除")

    uid = storage.delete_user(record["username"])
    if uid:
        _purge_traces(uid)
    return "", 204


def _purge_traces(uid: str) -> None:
    """清掉被删用户散落在别处的痕迹：公开链接、他人收件箱/发件箱里的记录。

    留着这些记录只会在界面上显示成来自幽灵用户的分享，不如一并清理。
    """
    storage.delete_links_of(uid)
    for other_uid in storage.list_uids():
        if other_uid == uid:
            continue
        with storage.mutate_inbox(other_uid) as inbox:
            kept = [s for s in inbox["shares"] if s.get("from_uid") != uid]
            if len(kept) == len(inbox["shares"]):
                raise storage.NoChange
            inbox["shares"] = kept
        with storage.mutate_outbox(other_uid) as outbox:
            kept = [s for s in outbox["shares"] if s.get("to_uid") != uid]
            if len(kept) == len(outbox["shares"]):
                raise storage.NoChange
            outbox["shares"] = kept
