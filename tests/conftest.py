"""共享测试夹具。

每个测试拿到一个全新的临时 data 目录，互不干扰。
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class ApiClient:
    """带 token 的薄封装，让测试读起来接近前端调用。"""

    def __init__(self, client, token: str | None = None, username: str | None = None):
        self.client = client
        self.token = token
        self.username = username

    def _headers(self, extra=None):
        headers = dict(extra or {})
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def get(self, path, **kw):
        return self.client.get(path, headers=self._headers(kw.pop("headers", None)), **kw)

    def post(self, path, json=None, **kw):
        return self.client.post(path, json=json, headers=self._headers(kw.pop("headers", None)), **kw)

    def patch(self, path, json=None, **kw):
        return self.client.patch(path, json=json, headers=self._headers(kw.pop("headers", None)), **kw)

    def delete(self, path, json=None, **kw):
        return self.client.delete(path, json=json, headers=self._headers(kw.pop("headers", None)), **kw)


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    directory = tmp_path / "data"
    monkeypatch.setenv("CLIPNEST_DATA_DIR", str(directory))
    monkeypatch.setenv("CLIPNEST_ADMIN_USERNAME", "1220")
    monkeypatch.setenv("CLIPNEST_TOKEN_DAYS", "30")
    return directory


@pytest.fixture()
def app(data_dir):
    from app import create_app
    from app import security

    security._failures.clear()  # 限流状态是进程内的，测试间必须清空
    application = create_app(verbose_bootstrap=False)
    application.config["TESTING"] = True
    return application


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def anon(client):
    """未认证客户端。"""
    return ApiClient(client)


@pytest.fixture()
def open_registration(app):
    """打开注册开关（默认是关闭的）。"""
    from app import storage

    with app.app_context():
        with storage.mutate_app_config() as cfg:
            cfg["registration_open"] = True
    return True


@pytest.fixture()
def invite_code(app):
    from app import invite

    with app.app_context():
        return invite.current_code()


@pytest.fixture()
def make_user(app, client, open_registration, invite_code):
    """注册并登录一个普通用户，返回 ApiClient。"""

    def _make(username: str = "tester", password: str = "password123"):
        response = client.post(
            "/api/auth/register",
            json={"username": username, "password": password, "invite_code": invite_code},
        )
        assert response.status_code == 201, response.get_json()
        return ApiClient(client, response.get_json()["token"], username)

    return _make


@pytest.fixture()
def user(make_user):
    return make_user("alice")


@pytest.fixture()
def other_user(make_user):
    return make_user("bob")


@pytest.fixture()
def admin(app, client):
    """初始管理员 1220 —— 直接签发 token，不依赖随机初始密码。"""
    from app import security, storage

    with app.app_context():
        record = storage.get_user("1220")
        assert record is not None, "bootstrap 应当创建初始管理员"
        token = security.issue_token(record)
    return ApiClient(client, token, "1220")


def ok(response, status: int = 200):
    """断言状态码并返回 JSON，失败时把响应体打进断言消息方便定位。"""
    assert response.status_code == status, (response.status_code, response.get_data(as_text=True))
    return response.get_json()


def err(response, code: str, status: int | None = None):
    """断言错误码。"""
    payload = response.get_json()
    assert payload and "error" in payload, response.get_data(as_text=True)
    assert payload["error"]["code"] == code, payload
    if status is not None:
        assert response.status_code == status, (response.status_code, payload)
    return payload["error"]
