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

READ_OPERATIONS = frozenset({
    "list_accounts", "list_mailboxes", "list_messages", "read_message",
    "search_messages", "confirm_messages", "save_attachment", "trash_destination",
})
# Opening a window cannot duplicate or lose mail, so its failures are never uncertain writes.
UI_OPERATIONS = frozenset({"show_message"})
WRITE_OPERATIONS = frozenset({"create_draft", "reply_draft", "set_message_status", "move_message"})
OPERATIONS = READ_OPERATIONS | UI_OPERATIONS | WRITE_OPERATIONS
PUBLIC_NAMES = {"save_attachment": "read_attachment"}
MAX_RESPONSE = 2_000_000
TIMEOUT_SECONDS = 60  # Drafts wait up to 30 s for Mail's saved copy, after lookups that slow down while Mail is busy.
MAX_ERROR_DETAIL = 1000


class BridgeError(RuntimeError):
    """An operation failed without returning a trustworthy result."""

    def __init__(self, message: str, *, operation: str | None = None,
                 apple_script_error_number: int | float | None = None):
        self.operation = operation
        self.detail = message  # Undecorated, so a re-raise can extend it without repeating the prefix and suffixes.
        # Only an uncertain write can have side effects; every other failure left Mail unchanged.
        self.retry_safe = not isinstance(self, OutcomeUnknown)
        self.apple_script_error_number = apple_script_error_number
        if apple_script_error_number is not None:
            message += f" (apple_script_error_number={apple_script_error_number})"
        if operation is not None:
            message = f"{PUBLIC_NAMES.get(operation, operation)}: {message} (retry_safe={str(self.retry_safe).lower()})"
        super().__init__(message)


class OutcomeUnknown(BridgeError):
    """Mail might have accepted an operation before the transport failed."""


def uncertain_error(message: str, operation: str | None,
                    apple_script_error_number: int | float | None = None) -> BridgeError:
    error_type = BridgeError if operation in READ_OPERATIONS | UI_OPERATIONS else OutcomeUnknown
    if error_type is OutcomeUnknown:
        message += ". The write outcome is unknown. Do not retry a write before inspecting Mail."
    return error_type(message, operation=operation, apple_script_error_number=apple_script_error_number)


class MailBridge:
    def call(self, operation: str, arguments: dict) -> dict:
        if operation not in OPERATIONS:
            raise BridgeError("Unsupported Mail operation", operation=operation)
        if sys.platform != "darwin":
            raise BridgeError("Mail automation requires macOS", operation=operation)
        request = json.dumps({"operation": operation, "args": arguments}, ensure_ascii=True)
        if len(request) > MAX_RESPONSE:
            raise BridgeError("Mail request exceeds the size limit", operation=operation)
        try:
            result = run_bounded(
                ["/usr/bin/osascript", "-l", "JavaScript", str(Path(__file__).with_name("mail.js"))],
                request, timeout=TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise uncertain_error(f"Mail timed out: {error_detail(exc)}", operation) from exc
        except (ProcessCommunicationError, UnicodeError) as exc:
            raise uncertain_error(f"Mail returned excessive or invalid output: {error_detail(exc)}", operation) from exc
        except OSError as exc:
            raise BridgeError(f"Cannot start macOS Mail automation: {error_detail(exc)}", operation=operation) from exc
        if result.returncode != 0:
            detail = result.stderr.strip()[:MAX_ERROR_DETAIL] or "No stderr returned"
            raise uncertain_error(f"Mail automation failed (exit code {result.returncode}): {detail}", operation)
        return decode_response(result.stdout, operation=operation)


def error_detail(error: Exception) -> str:
    stderr = getattr(error, "stderr", None)
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", errors="replace")
    parts = (str(error), str(error.__cause__) if error.__cause__ else "", stderr)
    return "; ".join(part for part in parts if part)[:MAX_ERROR_DETAIL]


def decode_response(output: str, *, operation: str | None = None) -> dict:
    if len(output.encode("utf-8")) > MAX_RESPONSE:
        raise uncertain_error("Mail response exceeded the size limit", operation)
    try:
        envelope = json.loads(output)
    except (ValueError, TypeError) as exc:
        raise uncertain_error(f"Mail returned invalid JSON: {exc}", operation) from exc
    if not isinstance(envelope, dict) or type(envelope.get("ok")) is not bool:
        raise uncertain_error("Mail returned an invalid response", operation)
    if not envelope["ok"]:
        error = envelope.get("error")
        number = envelope.get("apple_script_error_number")
        if type(number) not in (int, float):
            number = None
        if isinstance(error, str) and error.startswith("Outcome unknown:"):
            if operation in READ_OPERATIONS | UI_OPERATIONS:
                error = error.removeprefix("Outcome unknown:").strip()
            raise uncertain_error(error[:MAX_ERROR_DETAIL], operation, number)
        raise BridgeError(error[:MAX_ERROR_DETAIL] if isinstance(error, str) else "Mail operation failed",
                          operation=operation, apple_script_error_number=number)
    if not isinstance(envelope.get("result"), dict):
        raise uncertain_error("Mail returned an invalid result", operation)
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
