"""统一错误类型与 JSON 错误响应。

所有业务错误都抛 ApiError，由 register_error_handlers 序列化成
{"error": {"code": ..., "message": ...}}，见 docs/API.md 1.1 节。
"""

from flask import jsonify
from werkzeug.exceptions import HTTPException

# code → 默认 HTTP 状态码
DEFAULT_STATUS = {
    "validation_error": 400,
    "invalid_invite": 400,
    "unauthorized": 401,
    "forbidden": 403,
    "registration_closed": 403,
    "not_found": 404,
    "conflict": 409,
    "quota_exceeded": 409,
    "payload_too_large": 413,
    "rate_limited": 429,
    "internal_error": 500,
}


class ApiError(Exception):
    """业务错误。status 省略时按 code 查 DEFAULT_STATUS。"""

    def __init__(self, code: str, message: str, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status if status is not None else DEFAULT_STATUS.get(code, 400)

    def to_response(self):
        return jsonify({"error": {"code": self.code, "message": self.message}}), self.status


# ── 常用快捷构造 ────────────────────────────────────────────

def bad_request(message: str) -> ApiError:
    return ApiError("validation_error", message)


def unauthorized(message: str = "需要登录") -> ApiError:
    return ApiError("unauthorized", message)


def forbidden(message: str = "没有权限") -> ApiError:
    return ApiError("forbidden", message)


def not_found(message: str = "资源不存在") -> ApiError:
    return ApiError("not_found", message)


def conflict(message: str) -> ApiError:
    return ApiError("conflict", message)


def quota_exceeded(message: str) -> ApiError:
    return ApiError("quota_exceeded", message)


def register_error_handlers(app):
    @app.errorhandler(ApiError)
    def _api_error(err: ApiError):
        return err.to_response()

    @app.errorhandler(HTTPException)
    def _http_error(err: HTTPException):
        # 请求体超过 MAX_CONTENT_LENGTH 时 Flask 抛 413，转成统一格式
        code = {
            400: "validation_error",
            401: "unauthorized",
            403: "forbidden",
            404: "not_found",
            405: "validation_error",
            413: "payload_too_large",
            429: "rate_limited",
        }.get(err.code, "internal_error")
        message = "请求体过大" if err.code == 413 else (err.description or "请求失败")
        return jsonify({"error": {"code": code, "message": message}}), err.code

    @app.errorhandler(Exception)
    def _unexpected(err: Exception):
        app.logger.exception("未处理异常: %s", err)
        return jsonify({"error": {"code": "internal_error", "message": "服务器内部错误"}}), 500

    @app.after_request
    def _harden(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        return resp
