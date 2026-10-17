#!/usr/bin/env python3
"""Build the image on this computer and run it on a Portainer environment.

No registry is involved: the image is built with the local Docker, uploaded
to Portainer (docker/images/load) and started as a stack made from
deploy/portainer-stack.yml.

    python deploy/portainer.py              build, upload, create or update the stack
    python deploy/portainer.py --no-build   upload the image that is already built
    python deploy/portainer.py --dry-run    show what would be sent, change nothing

Settings come from .env in the repository root (see .env.example):

    PORTAINER_URL, PORTAINER_TOKEN
        Portainer address and an access token.
    PORTAINER_ENDPOINT_ID
        Optional; default: the first Docker environment that is up.
    AUGUSTUS_*
        Passed to the stack.
    AUGUSTUS_DEPLOY_*
        Override the matching AUGUSTUS_* for the stack only
        (AUGUSTUS_DEPLOY_DATA_PATH -> AUGUSTUS_DATA_PATH), so one .env serves
        both a local "docker compose up" and the deployed stack.

Needs Docker and Python 3.8 or later, no extra packages.
"""
import argparse
import json
import os
import pathlib
import ssl
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

PREFIX = "AUGUSTUS"
IMAGE = "augustus-web:latest"
STACK = "augustus"

ROOT = pathlib.Path(__file__).resolve().parent.parent
STACK_FILE = ROOT / "deploy" / "portainer-stack.yml"
SECRET_WORDS = ("PASSWORD", "TOKEN", "SECRET", "HASH")


def read_env():
    path = ROOT / ".env"
    if not path.exists():
        sys.exit("No .env in the repository root: copy .env.example to .env and fill it in")
    env = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        env[key.strip()] = value
    for key in ("PORTAINER_URL", "PORTAINER_TOKEN"):
        if not env.get(key):
            sys.exit(f"Set {key} in .env")
    return env


class Portainer:
    def __init__(self, url, token):
        self.url = url.rstrip("/")
        self.token = token
        # Portainer often runs with a self-signed certificate on a LAN.
        self.ssl = ssl._create_unverified_context()

    def call(self, method, path, body=None, ctype="application/json", timeout=60, length=None):
        headers = {"X-API-Key": self.token}
        if body is not None:
            headers["Content-Type"] = ctype
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            if length is not None:
                headers["Content-Length"] = str(length)
        req = urllib.request.Request(self.url + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self.ssl) as resp:
                text = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as err:
            sys.exit(f"{method} {path}: HTTP {err.code} {err.read().decode('utf-8', 'replace')[:500]}")
        try:
            return json.loads(text) if text.strip() else None
        except ValueError:
            return text

    def endpoint(self, wanted):
        if wanted:
            return int(wanted)
        for ep in self.call("GET", "/api/endpoints"):
            if ep.get("Type") in (1, 2) and ep.get("Status") == 1:
                return ep["Id"]
        sys.exit("No Docker environment is up in Portainer")


def stack_env(env):
    """PREFIX_* settings for the stack, PREFIX_DEPLOY_* taking precedence."""
    override = PREFIX + "_DEPLOY_"
    out = {k: v for k, v in env.items() if k.startswith(PREFIX + "_") and not k.startswith(override)}
    for key, value in env.items():
        if key.startswith(override):
            out[PREFIX + "_" + key[len(override):]] = value
    return [{"name": k, "value": v} for k, v in sorted(out.items())]


def masked(item):
    secret = any(word in item["name"] for word in SECRET_WORDS)
    return f"  {item['name']}=" + (f"<{len(item['value'])} characters>" if secret else item["value"])


def docker(*args):
    subprocess.run(["docker", *args], check=True)


def upload(api, endpoint):
    with tempfile.TemporaryDirectory() as tmp:
        tar = pathlib.Path(tmp) / "image.tar"
        print(f"Saving {IMAGE} ...")
        docker("save", "-o", str(tar), IMAGE)
        size = tar.stat().st_size
        print(f"Uploading {size / 2**20:.0f} MB to Portainer ...")
        with tar.open("rb") as f:
            result = api.call("POST", f"/api/endpoints/{endpoint}/docker/images/load?quiet=1",
                              body=f, ctype="application/x-tar", timeout=3600, length=size)
    if isinstance(result, str) and "error" in result.lower():
        sys.exit(f"Image upload failed: {result[:500]}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--no-build", action="store_true", help="skip docker build")
    parser.add_argument("--dry-run", action="store_true", help="only show what would be done")
    args = parser.parse_args()

    env = read_env()
    api = Portainer(env["PORTAINER_URL"], env["PORTAINER_TOKEN"])
    endpoint = api.endpoint(env.get("PORTAINER_ENDPOINT_ID"))
    compose = STACK_FILE.read_text(encoding="utf-8")
    variables = stack_env(env)
    existing = next((s for s in api.call("GET", "/api/stacks")
                     if s["Name"] == STACK and s["EndpointId"] == endpoint), None)

    if args.dry_run:
        print(f"Portainer {api.url}, environment {endpoint}")
        print(f"Stack '{STACK}': " + (f"exists (id {existing['Id']}), would be updated"
                                      if existing else "does not exist, would be created"))
        print(f"Image {IMAGE}: " + ("not rebuilt" if args.no_build else "built from " + str(ROOT)))
        print("Stack variables:")
        print("\n".join(masked(v) for v in variables))
        return

    if not args.no_build:
        print(f"Building {IMAGE} ...")
        docker("build", "-t", IMAGE, str(ROOT))
    upload(api, endpoint)

    if existing:
        print(f"Updating stack '{STACK}' ...")
        api.call("PUT", f"/api/stacks/{existing['Id']}?endpointId={endpoint}",
                 {"stackFileContent": compose, "env": variables, "prune": True, "pullImage": False},
                 timeout=600)
    else:
        print(f"Creating stack '{STACK}' ...")
        api.call("POST", f"/api/stacks/create/standalone/string?endpointId={endpoint}",
                 {"name": STACK, "stackFileContent": compose, "env": variables}, timeout=600)
    port = next((v["value"] for v in variables if v["name"] == PREFIX + "_HTTP_PORT"), "8080")
    host = api.url.split("://", 1)[-1].split(":", 1)[0].split("/", 1)[0]
    print(f"Done: http://{host}:{port} (put your HTTPS reverse proxy in front of it)")


if __name__ == "__main__":
    main()
