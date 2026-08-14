"""文件夹树操作。

store.py（CRUD）与 share.py（快照导出 / 落地）都要操作这棵树，
公共逻辑放这里，避免两处各写一份走样。

store 的形状：{"rev": int, "folders": [Folder], "items": [Item]}
根级用 parent_id / folder_id == None 表示。
"""

from app import storage, validators
from app.errors import not_found, quota_exceeded


def _folder_name(raw) -> str:
    """快照落地时用：来源数据可能不干净，截断而不是报错。"""
    name = raw.strip() if isinstance(raw, str) else ""
    return (name or validators.DEFAULT_TITLE)[: validators.MAX_FOLDER_NAME]


# ── 查找 ─────────────────────────────────────────────────

def find_folder(store: dict, fid) -> dict | None:
    if not fid:
        return None
    return next((f for f in store["folders"] if f["id"] == fid), None)


def find_item(store: dict, iid) -> dict | None:
    if not iid:
        return None
    return next((i for i in store["items"] if i["id"] == iid), None)


def require_folder(store: dict, fid) -> dict:
    folder = find_folder(store, fid)
    if folder is None:
        raise not_found("文件夹不存在")
    return folder


def require_item(store: dict, iid) -> dict:
    item = find_item(store, iid)
    if item is None:
        raise not_found("条目不存在")
    return item


def ensure_parent(store: dict, parent_id) -> None:
    """parent_id 为 None 表示根级，合法；否则必须存在。"""
    if parent_id is not None:
        require_folder(store, parent_id)


# ── 结构 ─────────────────────────────────────────────────

def child_folders(store: dict, parent_id) -> list[dict]:
    return [f for f in store["folders"] if f.get("parent_id") == parent_id]


def items_in(store: dict, folder_id) -> list[dict]:
    return [i for i in store["items"] if i.get("folder_id") == folder_id]


def depth_of(store: dict, fid) -> int:
    """根级文件夹深度为 1；fid 为 None 时返回 0。"""
    if fid is None:
        return 0
    depth = 0
    seen = set()
    cursor = fid
    while cursor is not None and cursor not in seen:
        seen.add(cursor)
        folder = find_folder(store, cursor)
        if folder is None:
            break
        depth += 1
        cursor = folder.get("parent_id")
    return depth


def descendant_ids(store: dict, fid: str) -> set[str]:
    """含自身。"""
    result = {fid}
    frontier = [fid]
    while frontier:
        current = frontier.pop()
        for child in child_folders(store, current):
            if child["id"] not in result:
                result.add(child["id"])
                frontier.append(child["id"])
    return result


def subtree_height(store: dict, fid: str) -> int:
    """子树层数，自身算 1 层。"""
    height = 1
    for child in child_folders(store, fid):
        height = max(height, 1 + subtree_height(store, child["id"]))
    return height


def next_order(store: dict, parent_id) -> int:
    siblings = child_folders(store, parent_id)
    return max((f.get("order", 0) for f in siblings), default=-1) + 1


def would_create_cycle(store: dict, fid: str, new_parent_id) -> bool:
    """把 fid 移到 new_parent_id 下是否会形成环。"""
    if new_parent_id is None:
        return False
    return new_parent_id in descendant_ids(store, fid)


# ── 限额 ─────────────────────────────────────────────────

def check_folder_quota(store: dict, adding: int = 1) -> None:
    if len(store["folders"]) + adding > validators.MAX_FOLDERS:
        raise quota_exceeded(f"文件夹数量已达上限 {validators.MAX_FOLDERS}")


def check_item_quota(store: dict, adding: int = 1) -> None:
    if len(store["items"]) + adding > validators.MAX_ITEMS:
        raise quota_exceeded(f"条目数量已达上限 {validators.MAX_ITEMS}")


def check_depth(store: dict, parent_id, extra_height: int = 1) -> None:
    """在 parent_id 下放一棵高 extra_height 的子树，校验总深度。"""
    total = depth_of(store, parent_id) + extra_height
    if total > validators.MAX_TREE_DEPTH:
        raise quota_exceeded(f"文件夹层级不能超过 {validators.MAX_TREE_DEPTH} 层")


# ── 构造 ─────────────────────────────────────────────────

def make_folder(store: dict, name: str, parent_id) -> dict:
    folder = {
        "id": storage.new_id("f"),
        "name": name,
        "parent_id": parent_id,
        "order": next_order(store, parent_id),
        "created_at": storage.now(),
    }
    store["folders"].append(folder)
    return folder


def make_item(store: dict, title: str, content: str, folder_id, pinned: bool = False) -> dict:
    stamp = storage.now()
    item = {
        "id": storage.new_id("i"),
        "folder_id": folder_id,
        "title": title,
        "content": content,
        "pinned": bool(pinned),
        "created_at": stamp,
        "updated_at": stamp,
    }
    store["items"].append(item)
    return item


# ── 删除 ─────────────────────────────────────────────────

def delete_folder(store: dict, fid: str, cascade: bool) -> tuple[int, int]:
    """返回 (删除的文件夹数, 删除的条目数)。

    cascade=False：子文件夹与直属条目提升到被删文件夹的父级。
    cascade=True ：递归删掉整棵子树。
    """
    folder = require_folder(store, fid)
    parent_id = folder.get("parent_id")

    if not cascade:
        for child in child_folders(store, fid):
            child["parent_id"] = parent_id
            child["order"] = next_order(store, parent_id)
        for item in items_in(store, fid):
            item["folder_id"] = parent_id
        store["folders"] = [f for f in store["folders"] if f["id"] != fid]
        return 1, 0

    doomed = descendant_ids(store, fid)
    removed_items = [i for i in store["items"] if i.get("folder_id") in doomed]
    store["items"] = [i for i in store["items"] if i.get("folder_id") not in doomed]
    store["folders"] = [f for f in store["folders"] if f["id"] not in doomed]
    return len(doomed), len(removed_items)


# ── 快照导出 / 落地（分享用）──────────────────────────────

def export_item(item: dict) -> dict:
    return {
        "kind": "item",
        "item": {"title": item.get("title", ""), "content": item.get("content", "")},
    }


def export_folder(store: dict, fid: str) -> dict:
    """把整棵子树导成与用户无关的快照。

    快照内 folders[].parent_id 用快照自身的 id；根的直接子文件夹
    parent_id 为 None。items[].folder_id 为 None 表示直接放在根下。
    """
    root = require_folder(store, fid)
    inside = descendant_ids(store, fid)
    descendants = inside - {fid}

    folders = [
        {
            "id": f["id"],
            "name": f.get("name", ""),
            "parent_id": None if f.get("parent_id") == fid else f.get("parent_id"),
            "order": f.get("order", 0),
        }
        for f in store["folders"]
        if f["id"] in descendants
    ]
    items = [
        {
            "folder_id": None if i.get("folder_id") == fid else i.get("folder_id"),
            "title": i.get("title", ""),
            "content": i.get("content", ""),
            "pinned": bool(i.get("pinned", False)),
        }
        for i in store["items"]
        if i.get("folder_id") in inside
    ]
    return {"kind": "folder", "name": root.get("name", ""), "folders": folders, "items": items}


def payload_height(payload: dict) -> int:
    """快照子树的层数（根算 1 层）。存在断链时按挂到根处理。"""
    folders = payload.get("folders") or []
    children: dict = {}
    known = {f.get("id") for f in folders}
    for folder in folders:
        parent = folder.get("parent_id")
        if parent not in known:
            parent = None
        children.setdefault(parent, []).append(folder.get("id"))

    height = 1
    frontier = [(fid, 2) for fid in children.get(None, [])]
    seen = set()
    while frontier:
        fid, level = frontier.pop()
        if fid in seen:
            continue
        seen.add(fid)
        height = max(height, level)
        frontier.extend((child, level + 1) for child in children.get(fid, []))
    return height


def payload_counts(payload: dict) -> tuple[int, int]:
    """返回落地后将新增的 (文件夹数, 条目数)。"""
    if payload.get("kind") == "item":
        return 0, 1
    return len(payload.get("folders") or []) + 1, len(payload.get("items") or [])


def import_payload(store: dict, payload: dict, folder_id) -> tuple[int, int]:
    """把快照落地到 store 的 folder_id 下。返回 (新增文件夹数, 新增条目数)。

    调用方负责先校验 folder_id 存在、限额与深度。
    """
    if payload.get("kind") == "item":
        data = payload.get("item") or {}
        make_item(
            store,
            validators.normalize_title(data.get("title")),
            validators.validate_content(data.get("content")),
            folder_id,
        )
        return 0, 1

    root = make_folder(store, _folder_name(payload.get("name")), folder_id)
    id_map: dict = {}

    pending = list(payload.get("folders") or [])
    while pending:
        progressed = False
        remaining = []
        for folder in pending:
            old_parent = folder.get("parent_id")
            if old_parent is None:
                new_parent = root["id"]
            elif old_parent in id_map:
                new_parent = id_map[old_parent]
            else:
                remaining.append(folder)
                continue
            created = make_folder(store, _folder_name(folder.get("name")), new_parent)
            id_map[folder.get("id")] = created["id"]
            progressed = True
        if not progressed:
            # 断链或成环的残留：一律挂到根下，不丢数据
            for folder in remaining:
                created = make_folder(store, _folder_name(folder.get("name")), root["id"])
                id_map[folder.get("id")] = created["id"]
            break
        pending = remaining

    for item in payload.get("items") or []:
        old_folder = item.get("folder_id")
        target = root["id"] if old_folder is None else id_map.get(old_folder, root["id"])
        make_item(
            store,
            validators.normalize_title(item.get("title")),
            validators.validate_content(item.get("content")),
            target,
            bool(item.get("pinned", False)),
        )

    folders_added = len(payload.get("folders") or []) + 1
    items_added = len(payload.get("items") or [])
    return folders_added, items_added


def summarize(payload: dict) -> str:
    """给收件箱/链接列表用的一句话摘要。"""
    if payload.get("kind") == "item":
        return (payload.get("item") or {}).get("title") or validators.DEFAULT_TITLE
    return payload.get("name") or validators.DEFAULT_TITLE


__all__ = [name for name in dir() if not name.startswith("_")]
