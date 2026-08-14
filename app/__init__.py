"""ClipNest 应用工厂。"""

from pathlib import Path

from flask import Flask

from app.bootstrap import bootstrap
from app.errors import register_error_handlers
from app.validators import MAX_REQUEST_BYTES

BASE_DIR = Path(__file__).resolve().parent.parent


def create_app(*, verbose_bootstrap: bool = True) -> Flask:
    app = Flask(
        __name__,
        static_folder=str(BASE_DIR / "static"),
        static_url_path="/static",
        template_folder=str(BASE_DIR / "templates"),
    )
    app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_BYTES
    app.config["JSON_AS_ASCII"] = False
    app.json.ensure_ascii = False

    bootstrap(verbose=verbose_bootstrap)
    register_error_handlers(app)

    # 蓝图在函数内导入：避免模块级循环依赖，也让 bootstrap 先于路由完成
    from app.api.admin import bp as admin_bp
    from app.api.auth import bp as auth_bp
    from app.api.share import bp as share_bp
    from app.api.share import public_bp
    from app.api.store import bp as store_bp
    from app.web import bp as web_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(store_bp)
    app.register_blueprint(share_bp)
    app.register_blueprint(public_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(web_bp)

    return app
