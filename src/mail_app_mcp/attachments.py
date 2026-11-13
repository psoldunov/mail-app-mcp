"""Bounded attachment export; filenames and document content remain untrusted."""

import base64
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

from .bridge import private_directory
from .models import MessageRef

MAX_BYTES = 10 * 1024 * 1024
MAX_BINARY_BYTES = 1024 * 1024
MAX_TEXT = 100_000


def extract_content(path: Path, mime: str) -> dict:
    if mime == "application/pdf":
        try:
            result = subprocess.run(
                [sys.executable, "-m", "mail_app_mcp.pdf_text", str(path)],
                capture_output=True, text=True, timeout=10, shell=False,
            )
            if result.returncode != 0:
                raise ValueError("PDF extraction failed or exceeded resource limits")
            content = json.loads(result.stdout)
            if not isinstance(content, dict) or "text" not in content:
                raise ValueError("PDF extraction failed; encrypted, malformed, or unsupported document")
            return content
        except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError) as exc:
            raise ValueError("PDF extraction failed or timed out") from exc
    if mime.startswith("text/"):
        text = path.read_bytes().decode("utf-8", errors="replace")
        return {"text": text[:MAX_TEXT], "truncated": len(text) > MAX_TEXT, "encoding": "utf-8 (replacement for invalid bytes)"}
    if path.stat().st_size > MAX_BINARY_BYTES:
        raise ValueError("Binary attachment exceeds the 1 MiB response limit; text/PDF extraction supports up to 10 MiB")
    return {"base64": base64.b64encode(path.read_bytes()).decode("ascii"), "encoding": "base64"}


def read_attachment_content(bridge, directory: Path, ref: MessageRef, attachment_id: str) -> dict:
    private_directory(directory)
    with tempfile.TemporaryDirectory(prefix="attachment-", dir=directory) as temporary:
        path = Path(temporary) / "content"
        metadata = bridge.call("save_attachment", {
            "ref": ref.model_dump(mode="json"), "attachment_id": attachment_id,
            "path": str(path), "max_bytes": MAX_BYTES,
        })
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
            raise ValueError("Mail export is not a safe regular file")
        if info.st_size > MAX_BYTES:
            raise ValueError("Attachment exceeds the 10 MiB size limit")
        path.chmod(0o600)
        mime = metadata.get("mime_type", "application/octet-stream")
        if not isinstance(mime, str):
            raise ValueError("Invalid attachment MIME type")
        return {"name": metadata.get("name", "attachment"), "mime_type": mime, "size": info.st_size,
                "untrusted": True, **({"warning": metadata["warning"]} if "warning" in metadata else {}),
                **extract_content(path, mime.split(";", 1)[0].lower())}
