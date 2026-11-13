"""Fixed Apple-event transport and per-user serialization."""

import fcntl
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
from contextlib import contextmanager

from .process import ProcessCommunicationError, run_bounded

OPERATIONS = frozenset({
    "list_accounts", "list_mailboxes", "list_messages", "read_message",
    "save_attachment", "create_draft", "reply_draft", "set_message_status", "move_message",
    "show_message", "show_draft",
})
MAX_RESPONSE = 2_000_000
TIMEOUT_SECONDS = 30


class BridgeError(RuntimeError):
    """An operation failed without returning a trustworthy result."""


class OutcomeUnknown(BridgeError):
    """Mail might have accepted an operation before the transport failed."""


class MailBridge:
    def call(self, operation: str, arguments: dict) -> dict:
        if operation not in OPERATIONS:
            raise BridgeError("Unsupported Mail operation")
        if sys.platform != "darwin":
            raise BridgeError("Mail automation requires macOS")
        request = json.dumps({"operation": operation, "args": arguments}, ensure_ascii=True)
        if len(request) > MAX_RESPONSE:
            raise BridgeError("Mail request exceeds the size limit")
        try:
            result = run_bounded(
                ["/usr/bin/osascript", "-l", "JavaScript", str(Path(__file__).with_name("mail.js"))],
                request, timeout=TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise OutcomeUnknown("Mail timed out; the outcome may be unknown. Do not retry a write before inspecting Mail.") from exc
        except (ProcessCommunicationError, UnicodeError) as exc:
            raise OutcomeUnknown("Mail returned excessive or invalid output. Inspect Mail before retrying a write.") from exc
        except OSError as exc:
            raise BridgeError("Cannot start macOS Mail automation") from exc
        if result.returncode != 0:
            raise OutcomeUnknown("Mail automation failed. Check Automation permission and inspect Mail before retrying a write.")
        return decode_response(result.stdout)


def decode_response(output: str) -> dict:
    if len(output.encode("utf-8")) > MAX_RESPONSE:
        raise OutcomeUnknown("Mail response exceeded the size limit; write outcome is unknown")
    try:
        envelope = json.loads(output)
    except (ValueError, TypeError) as exc:
        raise OutcomeUnknown("Mail returned invalid JSON; write outcome is unknown") from exc
    if not isinstance(envelope, dict) or type(envelope.get("ok")) is not bool:
        raise OutcomeUnknown("Mail returned an invalid response")
    if not envelope["ok"]:
        error = envelope.get("error")
        if isinstance(error, str) and error.startswith("Outcome unknown:"):
            raise OutcomeUnknown(error[:1000])
        raise BridgeError(error[:1000] if isinstance(error, str) else "Mail operation failed")
    if not isinstance(envelope.get("result"), dict):
        raise OutcomeUnknown("Mail returned an invalid result")
    return envelope["result"]


def private_directory(path: Path) -> Path:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise BridgeError("Runtime directory must be owned by you with permissions 0700, and not a symlink")
    return path


def runtime_directory() -> Path:
    return private_directory(Path.home() / "Library" / "Caches" / "mail-app-mcp")


@contextmanager
def write_lock(directory: Path):
    private_directory(directory)
    try:
        fd = os.open(directory / "writes.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    except OSError as exc:
        raise BridgeError("Cannot open the Mail write lock safely") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise BridgeError("Mail write lock has unsafe permissions")
        deadline = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise BridgeError("Another Mail operation is in progress; try again later")
                time.sleep(0.05)
        yield
    finally:
        os.close(fd)
