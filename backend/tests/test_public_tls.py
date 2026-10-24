"""Regressions for the actual public HTTPS trust paths (no network required)."""
import ssl
from pathlib import Path

import certifi
from cryptography import x509
from cryptography.hazmat.primitives import hashes

from app.tls import public_ssl_context


def test_public_context_does_not_merge_os_or_environment_roots(monkeypatch):
    monkeypatch.setenv("SSL_CERT_FILE", "nonexistent-untrusted-ca.pem")
    context = public_ssl_context()
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname
    actual = {x509.load_der_x509_certificate(raw).fingerprint(hashes.SHA256())
              for raw in context.get_ca_certs(binary_form=True)}
    bundled = {cert.fingerprint(hashes.SHA256()) for cert in
               x509.load_pem_x509_certificates(Path(certifi.where()).read_bytes())}
    assert actual == bundled
    names = [x509.load_der_x509_certificate(raw).subject.rfc4514_string()
             for raw in context.get_ca_certs(binary_form=True)]
    assert not any("emSign ECC Root CA - G3" in name or "AAA Certificate Services" in name for name in names)



def test_openai_sdk_transport_uses_application_roots(monkeypatch):
    import asyncio
    from app.ai_reviewer import AIReviewer

    monkeypatch.setenv("SSL_CERT_FILE", "nonexistent-untrusted-ca.pem")
    reviewer = AIReviewer(api_key="test-key", base_url="https://example.test/v1", model_name="test")
    try:
        context = reviewer._client._client._transport._pool._ssl_context
        assert context.verify_mode == ssl.CERT_REQUIRED
        assert context.check_hostname
        assert set(context.get_ca_certs(binary_form=True)) == set(public_ssl_context().get_ca_certs(binary_form=True))
    finally:
        asyncio.run(reviewer._client.close())
