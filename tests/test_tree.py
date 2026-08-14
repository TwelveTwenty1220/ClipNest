"""文件夹树工具测试。纯内存 store，不碰文件。"""

import pytest

from app import tree, validators
from app.errors import ApiError


@pytest.fixture()
def store():
    return {"rev": 0, "folders": [], "items": []}


@pytest.fixture()
def sample(store):
    """项目 / 配置 / 老版本 + 工作，条目散布其中。"""
    val = tree.make_folder(store, "项目", None)
    cross = tree.make_folder(store, "配置", val["id"])
    legacy = tree.make_folder(store, "老版本", cross["id"])
    work = tree.make_folder(store, "工作", None)
    tree.make_item(store, "根条目", "root", None)
    tree.make_item(store, "默认配置", "PORT=8420", cross["id"])
    tree.make_item(store, "旧配置", "PORT=9000", legacy["id"])
    tree.make_item(store, "周报模板", "本周", work["id"])
    return {"store": store, "val": val, "cross": cross, "legacy": legacy, "work": work}


def test_depth_and_height(sample):
    store, val, cross, legacy = sample["store"], sample["val"], sample["cross"], sample["legacy"]
    assert tree.depth_of(store, None) == 0
    assert tree.depth_of(store, val["id"]) == 1
    assert tree.depth_of(store, cross["id"]) == 2
    assert tree.depth_of(store, legacy["id"]) == 3
    assert tree.subtree_height(store, val["id"]) == 3
    assert tree.subtree_height(store, legacy["id"]) == 1


def test_depth_of_survives_broken_parent_link(store):
    store["folders"].append({"id": "f_orphan", "name": "孤儿", "parent_id": "f_gone", "order": 0})
    assert tree.depth_of(store, "f_orphan") == 1


def test_depth_of_survives_cycle(store):
    store["folders"] += [
        {"id": "f_a", "name": "a", "parent_id": "f_b", "order": 0},
        {"id": "f_b", "name": "b", "parent_id": "f_a", "order": 0},
    ]
    assert tree.depth_of(store, "f_a") == 2  # 不死循环即可


def test_descendant_ids(sample):
    store, val, cross, legacy = sample["store"], sample["val"], sample["cross"], sample["legacy"]
    assert tree.descendant_ids(store, val["id"]) == {val["id"], cross["id"], legacy["id"]}
    assert tree.descendant_ids(store, legacy["id"]) == {legacy["id"]}


def test_would_create_cycle(sample):
    store, val, cross, work = sample["store"], sample["val"], sample["cross"], sample["work"]
    assert tree.would_create_cycle(store, val["id"], cross["id"]) is True
    assert tree.would_create_cycle(store, val["id"], val["id"]) is True
    assert tree.would_create_cycle(store, val["id"], work["id"]) is False
    assert tree.would_create_cycle(store, val["id"], None) is False


def test_next_order_increments_per_parent(store):
    first = tree.make_folder(store, "a", None)
    second = tree.make_folder(store, "b", None)
    child = tree.make_folder(store, "c", first["id"])
    assert (first["order"], second["order"]) == (0, 1)
    assert child["order"] == 0  # 不同父级各自从 0 开始


def test_require_helpers_raise_not_found(store):
    for call in (lambda: tree.require_folder(store, "f_nope"), lambda: tree.require_item(store, "i_nope")):
        with pytest.raises(ApiError) as excinfo:
            call()
        assert excinfo.value.code == "not_found"


def test_ensure_parent_allows_none(store):
    tree.ensure_parent(store, None)  # 根级合法
    with pytest.raises(ApiError):
        tree.ensure_parent(store, "f_nope")


# ── 删除 ─────────────────────────────────────────────────

def test_delete_folder_promotes_children(sample):
    store, val, cross, legacy = sample["store"], sample["val"], sample["cross"], sample["legacy"]
    folders, items = tree.delete_folder(store, cross["id"], cascade=False)
    assert (folders, items) == (1, 0)
    # 老版本被提到项目下，配置里的条目也提上去了
    assert tree.find_folder(store, legacy["id"])["parent_id"] == val["id"]
    assert [i["title"] for i in tree.items_in(store, val["id"])] == ["默认配置"]
    assert tree.find_folder(store, cross["id"]) is None


def test_delete_root_folder_promotes_to_root(sample):
    store, val, cross = sample["store"], sample["val"], sample["cross"]
    tree.delete_folder(store, val["id"], cascade=False)
    assert tree.find_folder(store, cross["id"])["parent_id"] is None


def test_delete_folder_cascade(sample):
    store, val = sample["store"], sample["val"]
    folders, items = tree.delete_folder(store, val["id"], cascade=True)
    assert (folders, items) == (3, 2)
    assert [f["name"] for f in store["folders"]] == ["工作"]
    assert sorted(i["title"] for i in store["items"]) == ["周报模板", "根条目"]


# ── 限额 ─────────────────────────────────────────────────

def test_quota_guards(store, monkeypatch):
    monkeypatch.setattr(validators, "MAX_FOLDERS", 2)
    monkeypatch.setattr(validators, "MAX_ITEMS", 1)
    tree.make_folder(store, "a", None)
    tree.make_folder(store, "b", None)
    with pytest.raises(ApiError) as excinfo:
        tree.check_folder_quota(store)
    assert excinfo.value.code == "quota_exceeded"

    tree.make_item(store, "t", "c", None)
    with pytest.raises(ApiError):
        tree.check_item_quota(store)


def test_check_depth(store, monkeypatch):
    monkeypatch.setattr(validators, "MAX_TREE_DEPTH", 2)
    root = tree.make_folder(store, "a", None)
    tree.check_depth(store, root["id"], extra_height=1)  # 深度 2，刚好
    with pytest.raises(ApiError) as excinfo:
        tree.check_depth(store, root["id"], extra_height=2)
    assert excinfo.value.code == "quota_exceeded"


# ── 快照导出与落地 ────────────────────────────────────────

def test_export_item():
    payload = tree.export_item({"title": "配置", "content": "0;P", "id": "i_x", "pinned": True})
    assert payload == {"kind": "item", "item": {"title": "配置", "content": "0;P"}}


def test_export_folder_shape(sample):
    store, val, cross, legacy = sample["store"], sample["val"], sample["cross"], sample["legacy"]
    payload = tree.export_folder(store, val["id"])
    assert payload["kind"] == "folder"
    assert payload["name"] == "项目"
    # 根自身不在 folders 里，直接子文件夹的 parent_id 被置空
    assert {f["name"] for f in payload["folders"]} == {"配置", "老版本"}
    assert next(f for f in payload["folders"] if f["name"] == "配置")["parent_id"] is None
    assert next(f for f in payload["folders"] if f["name"] == "老版本")["parent_id"] == cross["id"]
    # 只带子树内的条目
    assert {i["title"] for i in payload["items"]} == {"默认配置", "旧配置"}


def test_export_folder_marks_direct_items(sample):
    store, cross = sample["store"], sample["cross"]
    payload = tree.export_folder(store, cross["id"])
    assert {i["title"]: i["folder_id"] for i in payload["items"]} == {
        "默认配置": None,
        "旧配置": sample["legacy"]["id"],
    }


def test_payload_height(sample):
    store, val, cross = sample["store"], sample["val"], sample["cross"]
    assert tree.payload_height(tree.export_folder(store, val["id"])) == 3
    assert tree.payload_height(tree.export_folder(store, cross["id"])) == 2
    assert tree.payload_height({"kind": "folder", "name": "空", "folders": [], "items": []}) == 1


def test_payload_counts(sample):
    store, val = sample["store"], sample["val"]
    assert tree.payload_counts(tree.export_folder(store, val["id"])) == (3, 2)
    assert tree.payload_counts({"kind": "item", "item": {}}) == (0, 1)


def test_import_item_payload(store):
    target = tree.make_folder(store, "收件", None)
    folders, items = tree.import_payload(
        store, {"kind": "item", "item": {"title": "", "content": "abc"}}, target["id"]
    )
    assert (folders, items) == (0, 1)
    created = tree.items_in(store, target["id"])[0]
    assert created["title"] == validators.DEFAULT_TITLE  # 空标题回落
    assert created["content"] == "abc"


def test_import_folder_roundtrip(sample):
    store, val = sample["store"], sample["val"]
    payload = tree.export_folder(store, val["id"])

    fresh = {"rev": 0, "folders": [], "items": []}
    folders, items = tree.import_payload(fresh, payload, None)
    assert (folders, items) == (3, 2)

    root = next(f for f in fresh["folders"] if f["parent_id"] is None)
    assert root["name"] == "项目"
    cross = next(f for f in fresh["folders"] if f["name"] == "配置")
    legacy = next(f for f in fresh["folders"] if f["name"] == "老版本")
    assert cross["parent_id"] == root["id"]
    assert legacy["parent_id"] == cross["id"]
    # id 全部重新生成，不复用来源 id
    assert {f["id"] for f in fresh["folders"]}.isdisjoint({f["id"] for f in store["folders"]})
    assert {i["title"] for i in tree.items_in(fresh, cross["id"])} == {"默认配置"}
    assert {i["title"] for i in tree.items_in(fresh, legacy["id"])} == {"旧配置"}


def test_import_folder_handles_out_of_order_payload():
    """folders 顺序打乱（子在父之前）也能正确重建。"""
    payload = {
        "kind": "folder",
        "name": "根",
        "folders": [
            {"id": "f_c", "name": "孙", "parent_id": "f_b", "order": 0},
            {"id": "f_b", "name": "子", "parent_id": None, "order": 0},
        ],
        "items": [{"folder_id": "f_c", "title": "深处", "content": "x", "pinned": False}],
    }
    store = {"rev": 0, "folders": [], "items": []}
    tree.import_payload(store, payload, None)
    root = next(f for f in store["folders"] if f["parent_id"] is None)
    child = next(f for f in store["folders"] if f["name"] == "子")
    grandchild = next(f for f in store["folders"] if f["name"] == "孙")
    assert child["parent_id"] == root["id"]
    assert grandchild["parent_id"] == child["id"]
    assert store["items"][0]["folder_id"] == grandchild["id"]


def test_import_folder_rescues_broken_links():
    """父引用指向不存在的 id 时挂到根下，不丢数据、不死循环。"""
    payload = {
        "kind": "folder",
        "name": "根",
        "folders": [{"id": "f_x", "name": "断链", "parent_id": "f_missing", "order": 0}],
        "items": [{"folder_id": "f_missing", "title": "游离", "content": "y", "pinned": False}],
    }
    store = {"rev": 0, "folders": [], "items": []}
    folders, items = tree.import_payload(store, payload, None)
    assert (folders, items) == (2, 1)
    root = next(f for f in store["folders"] if f["parent_id"] is None)
    assert next(f for f in store["folders"] if f["name"] == "断链")["parent_id"] == root["id"]
    assert store["items"][0]["folder_id"] == root["id"]


def test_import_folder_rescues_cycles():
    payload = {
        "kind": "folder",
        "name": "根",
        "folders": [
            {"id": "f_a", "name": "a", "parent_id": "f_b", "order": 0},
            {"id": "f_b", "name": "b", "parent_id": "f_a", "order": 0},
        ],
        "items": [],
    }
    store = {"rev": 0, "folders": [], "items": []}
    folders, _ = tree.import_payload(store, payload, None)
    assert folders == 3
    assert len(store["folders"]) == 3


def test_import_truncates_overlong_folder_name():
    payload = {"kind": "folder", "name": "长" * 500, "folders": [], "items": []}
    store = {"rev": 0, "folders": [], "items": []}
    tree.import_payload(store, payload, None)
    assert len(store["folders"][0]["name"]) == validators.MAX_FOLDER_NAME


def test_summarize():
    assert tree.summarize({"kind": "item", "item": {"title": "配置"}}) == "配置"
    assert tree.summarize({"kind": "item", "item": {}}) == validators.DEFAULT_TITLE
    assert tree.summarize({"kind": "folder", "name": "项目"}) == "项目"
