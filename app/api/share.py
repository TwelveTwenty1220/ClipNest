"""分享 API —— 见 docs/API.md 第 5 节。

两种分享都是**快照拷贝**语义：发送/建链接的瞬间把子树深拷贝一份，
之后发送方怎么改自己的数据，都不会影响已经发出去的副本。

锁的用法：fcntl 锁不可重入，但跨文件嵌套是安全的。所以这里的写法统一是
"先用 load_* 只读拿到需要的东西 → 再逐个文件加锁写"，绝不在某个
mutate_* 块内再开同一个文件的 mutate_*。
"""

from flask import Blueprint, g, request

from app import storage, tree, validators
from app.errors import bad_request, conflict, not_found, quota_exceeded
from app.security import require_auth

bp = Blueprint("share", __name__, url_prefix="/api/share")
public_bp = Blueprint("public", __name__, url_prefix="/api/public")


# ── 对外视图 ─────────────────────────────────────────────
# 落盘记录里带着 from_uid / to_uid / owner_uid / payload 等内部字段，
# 一律在这里过滤掉，避免顺手把 uid 或别人的快照泄露出去。

def _inbox_view(share: dict) -> dict:
    return {
        "id": share.get("id"),
        "from": share.get("from", ""),
        "payload": share.get("payload") or {},
        "created_at": share.get("created_at", 0),
        "accepted_at": share.get("accepted_at"),
    }


def _outbox_view(share: dict) -> dict:
    return {
        "id": share.get("id"),
        "to": share.get("to", ""),
        "kind": share.get("kind", "item"),
        "summary": share.get("summary", ""),
        "created_at": share.get("created_at", 0),
        "accepted": bool(share.get("accepted", False)),
    }


def _link_view(link: dict) -> dict:
    token = link.get("token", "")
    return {
        "token": token,
        "url": f"/s/{token}",
        "kind": link.get("kind", "item"),
        "summary": link.get("summary", ""),
        "created_at": link.get("created_at", 0),
        "expires_at": link.get("expires_at"),
    }


def _newest_first(shares: list[dict]) -> list[dict]:
    return sorted(shares, key=lambda s: s.get("created_at", 0), reverse=True)


# ── 公共辅助 ─────────────────────────────────────────────

def _target(data: dict) -> tuple[str, str]:
    """取出并校验 {kind, id}。"""
    kind = validators.validate_kind(data.get("kind"))
    target_id = validators.require_str(data, "id", max_len=64, label="id")
    return kind, target_id


def _snapshot(uid: str, kind: str, target_id: str) -> dict:
    """导出快照。刻意走只读的 load_store：导出本身不改数据，
    也让后续写 inbox / outbox 时不必嵌在自己 store 的锁里。"""
    store = storage.load_store(uid)
    if kind == "item":
        return tree.export_item(tree.require_item(store, target_id))
    return tree.export_folder(store, target_id)


def _expired(link: dict) -> bool:
    expires_at = link.get("expires_at")
    return isinstance(expires_at, int) and expires_at <= storage.now()


# ── 定向分享 ─────────────────────────────────────────────

@bp.post("/direct")
@require_auth
def share_direct():
    data = validators.body(request.get_json(silent=True))
    to_name = validators.require_str(data, "to", max_len=32, label="接收方用户名")
    kind, target_id = _target(data)

    sender = g.user
    receiver = storage.get_user(to_name)
    if receiver is None:
        raise not_found("用户不存在")
    if receiver.get("uid") == sender["uid"]:
        raise bad_request("不能分享给自己")

    payload = _snapshot(sender["uid"], kind, target_id)
    share_id = storage.new_id("s")
    created_at = storage.now()

    # 先写对方收件箱：这一步可能因限额失败，失败时发件箱里不会留下孤儿记录
    with storage.mutate_inbox(receiver["uid"]) as inbox:
        if len(inbox["shares"]) >= validators.MAX_INBOX:
            raise quota_exceeded(f"对方收件箱已满（上限 {validators.MAX_INBOX}）")
        inbox["shares"].append(
            {
                "id": share_id,
                "from": sender["username"],
                "from_uid": sender["uid"],
                "payload": payload,
                "created_at": created_at,
                "accepted_at": None,
            }
        )

    record = {
        "id": share_id,
        "share_id": share_id,  # 与收件箱中的 id 相同，撤回时据此定位
        "to": receiver["username"],
        "to_uid": receiver["uid"],
        "kind": kind,
        "summary": tree.summarize(payload),
        "created_at": created_at,
        "accepted": False,
    }
    with storage.mutate_outbox(sender["uid"]) as outbox:
        outbox["shares"].append(record)

    return {"share": _outbox_view(record)}, 201


@bp.get("/inbox")
@require_auth
def list_inbox():
    shares = storage.load_inbox(g.user["uid"])["shares"]
    return {"shares": [_inbox_view(s) for s in _newest_first(shares)]}


@bp.post("/inbox/<sid>/accept")
@require_auth
def accept_share(sid: str):
    data = validators.body(request.get_json(silent=True))
    _, folder_id = validators.optional_id(data, "folder_id", "f")

    uid = g.user["uid"]
    # 只在自己的收件箱里找 —— 别人的 sid 一律 404，不泄露存在性
    share = next(
        (s for s in storage.load_inbox(uid)["shares"] if s.get("id") == sid), None
    )
    if share is None:
        raise not_found("分享不存在")
    payload = share.get("payload") or {}

    with storage.mutate_store(uid) as store:
        tree.ensure_parent(store, folder_id)
        new_folders, new_items = tree.payload_counts(payload)
        tree.check_item_quota(store, new_items)
        if new_folders:
            # 条目快照不新增层级，只有文件夹快照才需要校验深度
            tree.check_folder_quota(store, new_folders)
            tree.check_depth(store, folder_id, tree.payload_height(payload))
        created_folders, created_items = tree.import_payload(store, payload, folder_id)
    rev = store["rev"]  # mutate_store 退出时已经 +1

    accepted_at = storage.now()
    with storage.mutate_inbox(uid) as inbox:
        for entry in inbox["shares"]:
            if entry.get("id") == sid:
                entry["accepted_at"] = accepted_at

    _mark_sender_accepted(share.get("from_uid"), sid)

    return {"rev": rev, "created_items": created_items, "created_folders": created_folders}


def _mark_sender_accepted(from_uid, sid: str) -> None:
    """回写发送方发件箱的 accepted。发送方可能已注销，静默跳过即可 ——
    接收方已经把内容拿到手了，不该因为对方没了而失败。"""
    if not from_uid or storage.get_user_by_uid(from_uid) is None:
        return
    with storage.mutate_outbox(from_uid) as outbox:
        for entry in outbox["shares"]:
            if entry.get("id") == sid:
                entry["accepted"] = True


@bp.delete("/inbox/<sid>")
@require_auth
def delete_inbox_share(sid: str):
    with storage.mutate_inbox(g.user["uid"]) as inbox:
        remaining = [s for s in inbox["shares"] if s.get("id") != sid]
        if len(remaining) == len(inbox["shares"]):
            raise not_found("分享不存在")
        inbox["shares"] = remaining
    return {"ok": True}


@bp.get("/outbox")
@require_auth
def list_outbox():
    shares = storage.load_outbox(g.user["uid"])["shares"]
    return {"shares": [_outbox_view(s) for s in _newest_first(shares)]}


@bp.delete("/outbox/<sid>")
@require_auth
def revoke_outbox_share(sid: str):
    uid = g.user["uid"]
    record = next(
        (s for s in storage.load_outbox(uid)["shares"] if s.get("id") == sid), None
    )
    if record is None:
        raise not_found("分享不存在")
    if record.get("accepted"):
        raise conflict("对方已接受，无法撤回")

    to_uid = record.get("to_uid")
    if to_uid and storage.get_user_by_uid(to_uid) is not None:
        with storage.mutate_inbox(to_uid) as inbox:
            target = next((s for s in inbox["shares"] if s.get("id") == sid), None)
            if target is not None and target.get("accepted_at") is not None:
                # 发件箱的 accepted 可能没同步上，收件箱才是权威
                raise conflict("对方已接受，无法撤回")
            inbox["shares"] = [s for s in inbox["shares"] if s.get("id") != sid]

    with storage.mutate_outbox(uid) as outbox:
        outbox["shares"] = [s for s in outbox["shares"] if s.get("id") != sid]
    return {"ok": True}


# ── 公开链接 ─────────────────────────────────────────────

@bp.post("/link")
@require_auth
def create_link():
    data = validators.body(request.get_json(silent=True))
    kind, target_id = _target(data)
    expires_in = validators.optional_int(data, "expires_in", minimum=1)

    uid = g.user["uid"]
    payload = _snapshot(uid, kind, target_id)
    if len(storage.list_links(uid)) >= validators.MAX_LINKS:
        raise quota_exceeded(f"公开链接数量已达上限 {validators.MAX_LINKS}")

    created_at = storage.now()
    link = {
        "token": storage.new_link_token(),
        "owner_uid": uid,
        "kind": kind,
        "summary": tree.summarize(payload),
        "payload": payload,
        "created_at": created_at,
        "expires_at": None if expires_in is None else created_at + expires_in,
    }
    storage.save_link(link["token"], link)
    return {"link": _link_view(link)}, 201


@bp.get("/links")
@require_auth
def list_my_links():
    links = []
    for link in storage.list_links(g.user["uid"]):
        if _expired(link):
            storage.delete_link(link.get("token", ""))  # 惰性清理
            continue
        links.append(_link_view(link))
    return {"links": links}


@bp.delete("/links/<token>")
@require_auth
def delete_my_link(token: str):
    link = storage.load_link(token)
    # 别人的 token 与不存在的 token 返回同样的 404，不泄露存在性
    if not isinstance(link, dict) or link.get("owner_uid") != g.user["uid"]:
        raise not_found("链接不存在")
    storage.delete_link(token)
    return {"ok": True}


@public_bp.get("/<token>")
def read_public(token: str):
    """免认证。不存在 / 已撤销 / 已过期一律 404，不给探测留缝隙。"""
    link = storage.load_link(token)
    if not isinstance(link, dict):
        raise not_found("链接不存在")
    if _expired(link):
        storage.delete_link(token)
        raise not_found("链接不存在")
    return {
        "payload": link.get("payload") or {},
        "created_at": link.get("created_at", 0),
        "expires_at": link.get("expires_at"),
    }
