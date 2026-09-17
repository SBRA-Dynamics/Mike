#!/usr/bin/env python3
"""Log in to Claude and get a refresh token for the usage monitor.

The board reads plan usage from the same endpoint Claude Code uses, which accepts
OAuth tokens only. This script runs Claude Code's manual (copy/paste) OAuth login
so the board gets its own token, separate from the one Claude Code on this computer uses.

Interactive:
    python3 tools/claude_login.py [--write]

Two steps (e.g. when stdin is not a terminal):
    python3 tools/claude_login.py --start
    python3 tools/claude_login.py --code 'CODE#STATE' [--write]

--write puts the refresh token into main/secrets.h.
Only the Python standard library is needed.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
SCOPES = "user:profile user:inference"
USER_AGENT = "claude-usage-monitor/1.0"

PROJECT_DIR = Path(__file__).resolve().parent.parent
SECRETS_H = PROJECT_DIR / "main" / "secrets.h"
SECRETS_TEMPLATE = PROJECT_DIR / "main" / "secrets.example.h"
PENDING_FILE = Path.home() / ".cache" / "claude_usage_monitor_login.json"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def http_json(url: str, body: dict | None = None, token: str | None = None) -> dict:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
        headers["anthropic-beta"] = "oauth-2025-04-20"
    request = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:500]
        sys.exit(f"HTTP {err.code} from {url}: {detail}")


def start() -> dict:
    verifier = b64url(secrets.token_bytes(32))
    pending = {
        "verifier": verifier,
        "challenge": b64url(hashlib.sha256(verifier.encode()).digest()),
        "state": b64url(secrets.token_bytes(32)),
    }
    PENDING_FILE.parent.mkdir(parents=True, exist_ok=True)
    PENDING_FILE.write_text(json.dumps(pending))
    PENDING_FILE.chmod(0o600)

    query = urllib.parse.urlencode({
        "code": "true",
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
        "code_challenge": pending["challenge"],
        "code_challenge_method": "S256",
        "state": pending["state"],
    }, quote_via=urllib.parse.quote)
    url = f"{AUTHORIZE_URL}?{query}"
    print("1. Open this URL in a browser and sign in to claude.ai:\n")
    print(url + "\n")
    webbrowser.open(url)
    print("2. Copy the code that is shown after you authorize.")
    return pending


def exchange(code: str, pending: dict) -> dict:
    code = code.strip()
    auth_code, _, state = code.partition("#")
    if state and state != pending["state"]:
        sys.exit("The pasted code belongs to another login attempt; run --start again.")
    tokens = http_json(TOKEN_URL, {
        "grant_type": "authorization_code",
        "code": auth_code,
        "state": pending["state"],
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "code_verifier": pending["verifier"],
    })
    PENDING_FILE.unlink(missing_ok=True)
    return tokens


def write_secrets(refresh_token: str) -> None:
    if not SECRETS_H.exists():
        SECRETS_H.write_text(SECRETS_TEMPLATE.read_text())
    text = SECRETS_H.read_text()
    text, count = re.subn(r'#define CLAUDE_REFRESH_TOKEN "[^"]*"',
                          f'#define CLAUDE_REFRESH_TOKEN "{refresh_token}"', text)
    if count != 1:
        sys.exit(f"Could not find CLAUDE_REFRESH_TOKEN in {SECRETS_H}")
    SECRETS_H.write_text(text)
    print(f"Wrote CLAUDE_REFRESH_TOKEN to {SECRETS_H}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--start", action="store_true", help="only print the login URL")
    parser.add_argument("--code", help="code shown after authorizing (CODE#STATE)")
    parser.add_argument("--write", action="store_true", help="store the refresh token in main/secrets.h")
    args = parser.parse_args()

    if args.start:
        start()
        print("\n3. Run again with: --code 'PASTED_CODE'")
        return

    if args.code:
        if not PENDING_FILE.exists():
            sys.exit("No login in progress; run with --start first.")
        pending = json.loads(PENDING_FILE.read_text())
        code = args.code
    else:
        pending = start()
        code = input("\nPaste code: ")

    tokens = exchange(code, pending)
    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        sys.exit(f"No refresh token in response (keys: {sorted(tokens)})")

    usage = http_json(USAGE_URL, token=tokens["access_token"])
    for limit in usage.get("limits") or []:
        print(f"  {limit.get('kind')}: {limit.get('percent')}%")

    if args.write:
        write_secrets(refresh_token)
    else:
        print(f'\n#define CLAUDE_REFRESH_TOKEN "{refresh_token}"')


if __name__ == "__main__":
    main()
