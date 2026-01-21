import io
import os
import posixpath
import re
import sys
import tarfile
import time
from dataclasses import dataclass
from getpass import getpass

import paramiko


HOST_DEFAULT = "109.71.253.53"
USER_DEFAULT = "root"
REMOTE_BASE_DEFAULT = "/opt/contest-auction"


@dataclass
class DeployConfig:
    host: str = HOST_DEFAULT
    user: str = USER_DEFAULT
    remote_base: str = REMOTE_BASE_DEFAULT


def _project_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _fatal(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(code)


def _info(msg: str) -> None:
    print(msg)


def _build_tar_gz(project_dir: str) -> bytes:
    """Create a tar.gz archive of contest-auction/ excluding heavy/unwanted dirs."""
    excludes = {
        ".git",
        "node_modules",
        "dist",
    }

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for root, dirs, files in os.walk(project_dir):
            rel_root = os.path.relpath(root, project_dir)
            rel_root = "" if rel_root == "." else rel_root

            # prune excluded dirs
            pruned = []
            for d in list(dirs):
                if d in excludes:
                    pruned.append(d)
            for d in pruned:
                dirs.remove(d)

            # also prune any nested .git dirs just in case
            dirs[:] = [d for d in dirs if d not in excludes]

            for f in files:
                if f == ".DS_Store":
                    continue
                abs_path = os.path.join(root, f)
                rel_path = os.path.normpath(os.path.join(rel_root, f)).replace("\\", "/")

                # skip git metadata anywhere
                if rel_path.startswith(".git/"):
                    continue
                # skip dist/node_modules anywhere
                if rel_path.startswith("dist/") or rel_path.startswith("node_modules/"):
                    continue

                arcname = rel_path
                tf.add(abs_path, arcname=arcname)
    return buf.getvalue()


def _parse_env_example_keys(env_example_path: str) -> set[str]:
    keys: set[str] = set()
    if not os.path.exists(env_example_path):
        return keys

    with open(env_example_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            # KEY=VALUE
            m = re.match(r"^([A-Z0-9_]+)\s*=", line)
            if m:
                keys.add(m.group(1))
    return keys


def _ssh_connect(host: str, user: str, password: str) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=host,
            username=user,
            password=password,
            look_for_keys=False,
            allow_agent=False,
            timeout=20,
        )
    except Exception as e:
        _fatal(f"SSH connect failed: {e}")
    return client


def _run(ssh: paramiko.SSHClient, cmd: str, *, cwd: str | None = None, check: bool = True) -> str:
    full_cmd = cmd
    if cwd:
        # Use bash for 'set -euo pipefail' and proper quoting.
        full_cmd = f"cd {sh_quote(cwd)} && {cmd}"

    _info(f"$ {full_cmd}")
    stdin, stdout, stderr = ssh.exec_command(full_cmd, get_pty=True)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    rc = stdout.channel.recv_exit_status()
    if check and rc != 0:
        _fatal(f"Remote command failed (exit {rc}): {full_cmd}\n{out}{err}")
    return (out + err).strip()


def sh_quote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


def _upload_bytes(ssh: paramiko.SSHClient, remote_path: str, content: bytes) -> None:
    sftp = ssh.open_sftp()
    try:
        # Ensure remote parent dir exists
        parent = posixpath.dirname(remote_path)
        _run(ssh, f"mkdir -p {sh_quote(parent)}")

        with sftp.file(remote_path, "wb") as f:
            f.write(content)
    finally:
        sftp.close()


def _upload_text(ssh: paramiko.SSHClient, remote_path: str, content: str) -> None:
    _upload_bytes(ssh, remote_path, content.encode("utf-8"))


def _remote_prechecks(ssh: paramiko.SSHClient) -> None:
    _run(ssh, "command -v docker >/dev/null 2>&1 || (echo 'docker not found' && exit 2)")
    _run(
        ssh,
        "docker compose version >/dev/null 2>&1 || (echo 'docker compose plugin not found (docker compose)' && exit 2)",
    )
    _run(ssh, "command -v node >/dev/null 2>&1 || (echo 'node not found (need Node 20+)' && exit 2)")
    _run(ssh, "command -v npm >/dev/null 2>&1 || (echo 'npm not found' && exit 2)")
    # systemd is assumed on Ubuntu 24.04
    _run(ssh, "command -v systemctl >/dev/null 2>&1 || (echo 'systemctl not found' && exit 2)")

    out = _run(ssh, "node -p \"process.versions.node\"")
    m = re.match(r"^(\d+)", out.strip())
    if not m:
        _fatal(f"Can't parse node version: {out!r}")
    if int(m.group(1)) < 20:
        _fatal(f"Node {out.strip()} detected, need Node 20+ on server")


def _write_systemd_units(ssh: paramiko.SSHClient, app_dir: str) -> None:
    api_unit = f"""[Unit]
Description=contest-auction API
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory={app_dir}
EnvironmentFile={app_dir}/.env
ExecStart=/usr/bin/env node {app_dir}/dist/index.js
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
"""

    worker_unit = f"""[Unit]
Description=contest-auction worker
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory={app_dir}
EnvironmentFile={app_dir}/.env
ExecStart=/usr/bin/env node {app_dir}/dist/worker.js
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
"""

    _upload_text(ssh, "/etc/systemd/system/contest-auction-api.service", api_unit)
    _upload_text(ssh, "/etc/systemd/system/contest-auction-worker.service", worker_unit)
    _run(ssh, "systemctl daemon-reload")
    _run(ssh, "systemctl enable --now contest-auction-api.service")
    _run(ssh, "systemctl enable --now contest-auction-worker.service")


def _ensure_env(ssh: paramiko.SSHClient, app_dir: str) -> None:
    env_path = f"{app_dir}/.env"
    example_path = f"{app_dir}/.env.example"

    # Create .env from example if missing
    _run(
        ssh,
        f"test -f {sh_quote(env_path)} || (test -f {sh_quote(example_path)} && cp {sh_quote(example_path)} {sh_quote(env_path)})",
    )
    _run(ssh, f"test -f {sh_quote(env_path)} || (echo '.env.example missing and .env not present' && exit 3)")

    # Always ensure minimal variables exist (append if absent)
    minimal_defaults: dict[str, str] = {
        "HOST": "0.0.0.0",
        "PORT": "3000",
        "MONGODB_URI": "mongodb://localhost:27017",
        "MONGO_DB": "contest-auction",
        # worker
        "WORKER_INTERVAL_MS": "1000",
        "WORKER_MAX_BATCH": "50",
        # anti-sniping
        "ANTI_SNIPING_WINDOW_SEC": "10",
        "ANTI_SNIPING_EXTEND_SEC": "10",
        "ANTI_SNIPING_MAX_EXTENDS": "10",
    }

    # Append missing minimal keys safely (do not force/overwrite custom values)
    for key in sorted(minimal_defaults.keys()):
        default = minimal_defaults.get(key, "")
        # grep: return 0 if found, 1 if not found
        _run(
            ssh,
            (
                f"grep -qE '^{re.escape(key)}=' {sh_quote(env_path)} || "
                f"(echo {sh_quote(f'{key}={default}')} >> {sh_quote(env_path)})"
            ),
        )


def deploy(cfg: DeployConfig) -> None:
    project_dir = _project_root()
    if not os.path.isdir(project_dir):
        _fatal(f"Project dir not found: {project_dir}")

    # Optional: used only as an early warning. Real .env.example is shipped to server.
    if not os.path.exists(os.path.join(project_dir, ".env.example")):
        _info("WARN: local .env.example not found")

    password = getpass(f"SSH password for {cfg.user}@{cfg.host}: ")
    ssh = _ssh_connect(cfg.host, cfg.user, password)

    try:
        _remote_prechecks(ssh)

        remote_base = cfg.remote_base.rstrip("/")
        app_dir = f"{remote_base}/app"
        releases_dir = f"{remote_base}/releases"
        ts = time.strftime("%Y%m%d-%H%M%S")
        release_dir = f"{releases_dir}/{ts}"
        remote_tgz = f"{release_dir}/contest-auction.tgz"

        _run(ssh, f"mkdir -p {sh_quote(release_dir)}")

        _info("Packing project...")
        tgz = _build_tar_gz(project_dir)
        _info(f"Uploading archive ({len(tgz) // 1024} KiB)...")
        _upload_bytes(ssh, remote_tgz, tgz)

        # Extract to new dir, then atomically swap
        new_dir = f"{release_dir}/app"
        _run(ssh, f"mkdir -p {sh_quote(new_dir)}")
        _run(ssh, f"tar -xzf {sh_quote(remote_tgz)} -C {sh_quote(new_dir)}")

        # Ensure base dir exists, swap app
        _run(ssh, f"mkdir -p {sh_quote(remote_base)}")
        _run(
            ssh,
            (
                f"if [ -d {sh_quote(app_dir)} ]; then "
                f"rm -rf {sh_quote(remote_base + '/app_prev')} && mv {sh_quote(app_dir)} {sh_quote(remote_base + '/app_prev')}; "
                f"fi; "
                f"mv {sh_quote(new_dir)} {sh_quote(app_dir)}"
            ),
        )

        # .env
        _ensure_env(ssh, app_dir)

        # docker compose
        _run(ssh, "docker compose up -d", cwd=app_dir)

        # build
        _run(ssh, "npm ci", cwd=app_dir)
        _run(ssh, "npm run build", cwd=app_dir)

        # systemd
        _write_systemd_units(ssh, app_dir)
        _run(ssh, "systemctl restart contest-auction-api.service")
        _run(ssh, "systemctl restart contest-auction-worker.service")

        print("\nDONE")
        print(f"URL: http://{cfg.host}:3000/")
        print("systemd status:")
        print("  systemctl status contest-auction-api --no-pager")
        print("  systemctl status contest-auction-worker --no-pager")
        print("logs:")
        print("  journalctl -u contest-auction-api -f")
        print("  journalctl -u contest-auction-worker -f")
    finally:
        ssh.close()


def main() -> None:
    cfg = DeployConfig()

    # Simple argv parsing (no extra deps)
    # --host 1.2.3.4 --user root --remote-base /opt/contest-auction
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--host":
            i += 1
            cfg.host = args[i]
        elif a == "--user":
            i += 1
            cfg.user = args[i]
        elif a == "--remote-base":
            i += 1
            cfg.remote_base = args[i]
        else:
            _fatal(f"Unknown arg: {a}")
        i += 1

    deploy(cfg)


if __name__ == "__main__":
    main()

