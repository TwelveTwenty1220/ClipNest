"""分享 API —— 见 docs/API.md 第 5 节。"""

from flask import Blueprint

bp = Blueprint("share", __name__, url_prefix="/api/share")
public_bp = Blueprint("public", __name__, url_prefix="/api/public")
