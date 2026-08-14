"""认证 API —— 见 docs/API.md 第 3 节。"""

from flask import Blueprint

bp = Blueprint("auth", __name__, url_prefix="/api/auth")
