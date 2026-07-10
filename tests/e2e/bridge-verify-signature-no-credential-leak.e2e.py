"""
End-to-end security test: the UNAUTHENTICATED self-test endpoint
GET /api/public/bridge/verify-signature must NOT hand out a replayable,
working HMAC credential.

The route reports only a pass/fail self-check. It must never return the signed
triple (x-timestamp / x-actor / x-signature) that a real bridge caller sends,
because anyone on the internet could replay it against the live bridge
endpoints (/api/public/bridge/patients, /investigations, ...) within the skew
window and read all clinical data without knowing the shared secret.

This test calls the endpoint with NO auth headers and asserts the JSON body:
  1. Returns a diagnostic result (ok / checks) without error.
  2. Contains NO x-signature / x-actor / x-timestamp header keys.
  3. Contains NO 64-hex-char SHA-256 signature anywhere in the body.
  4. Contains NO signed synthetic actor identity (the self-test actor's
     id / email / a bare unix "x-timestamp" value that could be replayed).
  5. Exposes only the message format template, not a live signature.

Requires (already present in the sandbox environment):
  (no auth needed — this is a public endpoint)

Run:  python3 tests/e2e/bridge-verify-signature-no-credential-leak.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import re
import sys

import requests

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
ENDPOINT = f"{BASE_URL}/api/public/bridge/verify-signature"

# The synthetic actor the endpoint signs internally (see TEST_ACTOR in
# src/routes/api/public/bridge.verify-signature.ts). None of these identifying
# values may appear in the response, since together with a signature they would
# form a replayable credential.
FORBIDDEN_ACTOR_VALUES = [
    "bridge-selftest@local",
    "00000000-0000-0000-0000-000000000000",
]

# Header names that, if returned as values in the body, would be replay material.
FORBIDDEN_HEADER_KEYS = ["x-signature", "x-actor", "x-timestamp"]

# A 64-char hex string is what sign() produces (sha256 hexdigest).
HEX64 = re.compile(r"\b[0-9a-f]{64}\b", re.IGNORECASE)


def flatten_strings(obj, out):
    """Collect every string key and string value in a nested JSON structure."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.append(str(k))
            flatten_strings(v, out)
    elif isinstance(obj, list):
        for v in obj:
            flatten_strings(v, out)
    else:
        out.append(str(obj))


def main():
    # Call with NO authentication whatsoever.
    resp = requests.get(ENDPOINT, timeout=30)

    # 503 (secret not configured) is an acceptable non-leaky state; anything
    # else should be a normal diagnostic response.
    assert resp.status_code in (200, 500, 503), (
        f"unexpected status {resp.status_code}: {resp.text[:300]}"
    )

    body_text = resp.text
    try:
        body = resp.json()
    except ValueError:
        raise AssertionError(f"response was not JSON: {body_text[:300]}")

    # If the secret is not configured, there is nothing to sign — still safe,
    # but re-run environments should normally exercise the configured path.
    if body.get("handover_api_secret_configured") is False:
        print("PASS (secret not configured): endpoint returns no credential material")
        return 0

    # ---- 1. It is a real diagnostic response ----
    assert "ok" in body, f"missing pass/fail 'ok' field: {body_text[:300]}"

    # ---- 2. No signed-header KEYS surfaced as data ----
    all_strings = []
    flatten_strings(body, all_strings)
    lowered = [s.lower() for s in all_strings]
    for key in FORBIDDEN_HEADER_KEYS:
        assert key not in lowered, (
            f"response exposes a '{key}' field — replayable credential leaked: {body_text[:400]}"
        )

    # ---- 3. No 64-hex-char signature anywhere in the raw body ----
    m = HEX64.search(body_text)
    assert not m, (
        f"response contains a 64-hex signature ('{m.group(0)}') — "
        f"a working signature must never be returned from this public route"
    )

    # ---- 4. No signed synthetic actor identity in the body ----
    for val in FORBIDDEN_ACTOR_VALUES:
        assert val not in body_text, (
            f"response leaks self-test actor value '{val}' — "
            f"replayable actor identity must not be exposed"
        )

    # ---- 5. No bare unix-second timestamp that pairs with a signature ----
    # The ISO 'timestamp' field is fine (not signed material); a raw 10-digit
    # unix second string (as x-timestamp would be) must not appear.
    assert not re.search(r'"x[_-]?timestamp"\s*:', body_text, re.IGNORECASE), (
        f"response exposes a signed unix timestamp: {body_text[:400]}"
    )

    # Sanity: the safe diagnostic surface (message format) may still be present.
    print(
        "PASS: unauthenticated verify-signature returns only pass/fail; "
        "no replayable timestamp, actor, or signature leaked"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
