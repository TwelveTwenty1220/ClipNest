"""gunicorn 入口：gunicorn -w 1 --threads 8 wsgi:app"""

from app import create_app

app = create_app()

if __name__ == "__main__":
    from app import config

    app.run(host=config.host(), port=config.port(), debug=False)
