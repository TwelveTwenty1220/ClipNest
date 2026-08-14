"""文件夹与条目 API —— 见 docs/API.md 第 4 节。

树结构的公共逻辑全在 app/tree.py，这里只负责解析请求、拼装响应，
以及把每次写操作圈在一个 `mutate_store` 事务里（退出时自动 rev += 1）。

越权隔离靠"只在 g.user 自己的 store 里查"实现：别人的 id 在这里找不到，
`tree.require_folder` / `tree.require_item` 直接抛 404，不需要额外的归属判断。
"""

from flask import Blueprint, g, jsonify, request

from app import security, storage, tree, validators
from app.errors import bad_request, conflict

bp = Blueprint("store", __name__, url_prefix="/api/store")

TRUTHY = {"1", "true", "yes"}


def _uid() -> str:
    return g.user["uid"]


def _payload() -> dict:
    return validators.body(request.get_json(silent=True))


def _query_flag(name: str) -> bool:
    return (request.args.get(name) or "").strip().lower() in TRUTHY


def _sorted_folders(store: dict) -> list[dict]:
    """按 (parent_id, order) 排序，前端可以顺序建树。

    根级 parent_id 是 None，与字符串没法直接比较，统一映射成空串。
    """
    return sorted(store["folders"], key=lambda f: (f.get("parent_id") or "", f.get("order", 0)))


def _sorted_items(store: dict) -> list[dict]:
    """置顶优先，其次按最近更新倒序。"""
    return sorted(store["items"], key=lambda i: (not i.get("pinned", False), -int(i.get("updated_at", 0))))


def _inbox_count(uid: str) -> int:
    return sum(1 for s in storage.load_inbox(uid).get("shares", []) if s.get("accepted_at") is None)


# ── 增量拉取 ─────────────────────────────────────────────

@bp.get("")
@security.require_auth
def get_store():
    try:
        client_rev = int(request.args.get("rev", -1))
    except (TypeError, ValueError):
        client_rev = -1  # 参数脏了就当没带，强制全量，好过报错让前端卡住

    uid = _uid()
    store = storage.load_store(uid)
    if client_rev == store["rev"]:
        return jsonify({"changed": False, "rev": store["rev"]})

    return jsonify(
        {
            "changed": True,
            "rev": store["rev"],
            "folders": _sorted_folders(store),
            "items": _sorted_items(store),
            "inbox_count": _inbox_count(uid),
        }
    )


# ── 文件夹 ───────────────────────────────────────────────

@bp.post("/folders")
@security.require_auth
def create_folder():
    data = _payload()
    name = validators.validate_folder_name(data.get("name"))
    _, parent_id = validators.optional_id(data, "parent_id", "f")

    with storage.mutate_store(_uid()) as store:
        tree.ensure_parent(store, parent_id)
        tree.check_folder_quota(store)
        tree.check_depth(store, parent_id, 1)
        folder = dict(tree.make_folder(store, name, parent_id))
        rev = store["rev"] + 1

    return jsonify({"folder": folder, "rev": rev}), 201


@bp.patch("/folders/<fid>")
@security.require_auth
def update_folder(fid):
    data = _payload()
    parent_present, new_parent = validators.optional_id(data, "parent_id", "f")
    order = validators.optional_int(data, "order", minimum=0)
    name = validators.validate_folder_name(data.get("name")) if "name" in data else None

    with storage.mutate_store(_uid()) as store:
        folder = tree.require_folder(store, fid)
        changed = False

        if name is not None and name != folder.get("name"):
            folder["name"] = name
            changed = True

        if parent_present and new_parent != folder.get("parent_id"):
            tree.ensure_parent(store, new_parent)
            if tree.would_create_cycle(store, fid, new_parent):
                raise conflict("不能把文件夹移动到自身或自己的子文件夹下")
            # 移动的是整棵子树，深度要按子树高度算，不是按单个文件夹算
            tree.check_depth(store, new_parent, tree.subtree_height(store, fid))
            folder["order"] = tree.next_order(store, new_parent)  # 必须在改 parent_id 前算，否则会把自己算进兄弟里
            folder["parent_id"] = new_parent
            changed = True

        # order 放在最后：显式指定时应当覆盖移动带来的默认排序
        if order is not None and order != folder.get("order"):
            folder["order"] = order
            changed = True

        result = dict(folder)
        rev = store["rev"] + (1 if changed else 0)
        if not changed:
            raise storage.NoChange

    return jsonify({"folder": result, "rev": rev})


@bp.delete("/folders/<fid>")
@security.require_auth
def remove_folder(fid):
    cascade = _query_flag("cascade")

    with storage.mutate_store(_uid()) as store:
        deleted_folders, deleted_items = tree.delete_folder(store, fid, cascade)
        rev = store["rev"] + 1

    return jsonify({"rev": rev, "deleted_items": deleted_items, "deleted_folders": deleted_folders})


# ── 条目 ─────────────────────────────────────────────────

@bp.post("/items")
@security.require_auth
def create_item():
    data = _payload()
    if "content" not in data:
        raise bad_request("内容必填")
    title = validators.normalize_title(data.get("title"))
    content = validators.validate_content(data.get("content"))
    _, folder_id = validators.optional_id(data, "folder_id", "f")

    with storage.mutate_store(_uid()) as store:
        tree.ensure_parent(store, folder_id)
        tree.check_item_quota(store)
        item = dict(tree.make_item(store, title, content, folder_id))
        rev = store["rev"] + 1

    return jsonify({"item": item, "rev": rev}), 201


@bp.patch("/items/<iid>")
@security.require_auth
def update_item(iid):
    data = _payload()
    title = validators.normalize_title(data.get("title")) if "title" in data else None
    content = validators.validate_content(data.get("content")) if "content" in data else None
    folder_present, folder_id = validators.optional_id(data, "folder_id", "f")
    pinned = validators.optional_bool(data, "pinned")

    with storage.mutate_store(_uid()) as store:
        item = tree.require_item(store, iid)
        changed = False

        if title is not None and title != item.get("title"):
            item["title"] = title
            changed = True

        if content is not None and content != item.get("content"):
            item["content"] = content
            changed = True

        if folder_present and folder_id != item.get("folder_id"):
            tree.ensure_parent(store, folder_id)
            item["folder_id"] = folder_id
            changed = True

        if pinned is not None and bool(pinned) != bool(item.get("pinned", False)):
            item["pinned"] = bool(pinned)
            changed = True

        if changed:
            item["updated_at"] = storage.now()

        result = dict(item)
        rev = store["rev"] + (1 if changed else 0)
        if not changed:
            raise storage.NoChange

    return jsonify({"item": result, "rev": rev})


@bp.delete("/items/<iid>")
@security.require_auth
def remove_item(iid):
    with storage.mutate_store(_uid()) as store:
        tree.require_item(store, iid)
        store["items"] = [i for i in store["items"] if i["id"] != iid]
        rev = store["rev"] + 1

    return jsonify({"rev": rev})
