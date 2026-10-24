"""Public HTTPS uses the application CA bundle, without merging OS roots."""
import ssl

import certifi


def public_ssl_context() -> ssl.SSLContext:
    return ssl.create_default_context(cafile=certifi.where())
