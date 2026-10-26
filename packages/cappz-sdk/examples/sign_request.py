#!/usr/bin/env python3
"""CAPPZ signed request from Python (any server-side language works the same way).

Signs an HTTP request with an Ed25519 device key — RFC 9421 HTTP Message
Signatures over "@method" "@path" "@authority" "content-digest" "cappz-wallet",
with an RFC 9530 Content-Digest — and sends it to a CAPPZ edge node:
the DMZ drop box (/legacy/v1/drop/<name>) or any API behind the verify gateway.

  pip install cryptography requests
  python3 sign_request.py --new-key device.key          # once: makes the key, prints its public key
  # declare that public key from your wallet (SDK: declareKey(...)) and save the JSON as declaration.json
  python3 sign_request.py --key device.key --wallet <wallet address> \
      --declaration declaration.json --url http://127.0.0.1:41447/legacy/v1/drop/statement.xml --file statement.xml

Without --declaration the signature still verifies; the gateway reports the
key as 'undeclared' (a drop's sender check is then 'not-evaluated').
"""
import argparse, base64, hashlib, json, os, secrets, sys, time, urllib.parse, urllib.request
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

COMPONENTS = ["@method", "@path", "@authority", "content-digest", "cappz-wallet"]


def load_or_make(path, new):
    if new:
        key = Ed25519PrivateKey.generate()
        open(path, "wb").write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        os.chmod(path, 0o600)
        return key
    return serialization.load_pem_private_key(open(path, "rb").read(), password=None)


def public_hex(key):
    return key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()


def signed_headers(key, method, url, body, wallet, declaration=None):
    u = urllib.parse.urlsplit(url)
    digest = "sha-256=:" + base64.b64encode(hashlib.sha256(body).digest()).decode() + ":"
    params = '(' + " ".join(f'"{c}"' for c in COMPONENTS) + f');created={int(time.time())};keyid="{public_hex(key)}";alg="ed25519";nonce="{secrets.token_hex(12)}"'
    values = {"@method": method.upper(), "@path": u.path or "/", "@authority": u.netloc.lower(), "content-digest": digest, "cappz-wallet": wallet}
    base = "\n".join(f'"{c}": {values[c]}' for c in COMPONENTS) + f'\n"@signature-params": {params}'
    sig = base64.b64encode(key.sign(base.encode())).decode()
    h = {"content-digest": digest, "cappz-wallet": wallet, "signature-input": f"sig1={params}", "signature": f"sig1=:{sig}:"}
    if declaration:
        h["cappz-key-declaration"] = base64.urlsafe_b64encode(json.dumps(declaration).encode()).decode().rstrip("=")
    return h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default="device.key"); ap.add_argument("--new-key")
    ap.add_argument("--wallet"); ap.add_argument("--declaration"); ap.add_argument("--url"); ap.add_argument("--file")
    ap.add_argument("--method", default="PUT"); ap.add_argument("--content-type", default="application/octet-stream")
    a = ap.parse_args()
    if a.new_key:
        print(public_hex(load_or_make(a.new_key, True))); return
    key = load_or_make(a.key, False)
    body = open(a.file, "rb").read() if a.file else b""
    decl = json.load(open(a.declaration)) if a.declaration else None
    headers = signed_headers(key, a.method, a.url, body, a.wallet, decl)
    headers["content-type"] = a.content_type
    req = urllib.request.Request(a.url, data=body if a.method.upper() not in ("GET", "HEAD") else None, method=a.method.upper(), headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            print(r.status, r.read().decode()[:2000])
    except urllib.error.HTTPError as e:
        print(e.code, e.read().decode()[:2000]); sys.exit(1)


if __name__ == "__main__":
    main()
