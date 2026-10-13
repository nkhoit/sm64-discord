#!/usr/bin/env python3
"""Stand-in for the parts of Discord's API the relay calls, for local tests.

    python3 server/tests/mock_discord.py 8199
    DISCORD_API_BASE=http://127.0.0.1:8199 DISCORD_CLIENT_ID=1 DISCORD_CLIENT_SECRET=x server/build/sm64-relay ...

OAuth code "code-<user>" becomes access token "token-<user>". Every user is a member of
guild 111111111111111111 and of no other guild.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

MEMBER_GUILD = "111111111111111111"


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def user(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer token-"):
            return None
        return auth[len("Bearer token-"):]

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        form = parse_qs(self.rfile.read(length).decode())
        if self.path != "/api/oauth2/token" or form.get("grant_type") != ["authorization_code"]:
            return self.send_json(400, {"error": "invalid_request"})
        code = form.get("code", [""])[0]
        if not code.startswith("code-") or form.get("client_secret") != ["mock-secret"]:
            return self.send_json(400, {"error": "invalid_grant"})
        self.send_json(200, {"access_token": "token-" + code[len("code-"):], "token_type": "Bearer"})

    def do_GET(self):
        user = self.user()
        if user is None:
            return self.send_json(401, {"message": "401: Unauthorized"})
        if self.path == "/api/users/@me":
            return self.send_json(200, {"id": str(abs(hash(user)) % 10**18), "username": user,
                                        "global_name": user.capitalize()})
        member_guilds = {MEMBER_GUILD}
        if user == "dual":
            member_guilds.add("222222222222222222")
        if self.path.startswith("/api/users/@me/guilds/") and self.path.endswith("/member"):
            guild = self.path.split("/")[5]
            if guild in member_guilds:
                return self.send_json(200, {"nick": None, "roles": []})
        self.send_json(404, {"message": "Unknown Guild"})

    def log_message(self, fmt, *args):
        sys.stderr.write("[mock-discord] " + fmt % args + "\n")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8199
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
