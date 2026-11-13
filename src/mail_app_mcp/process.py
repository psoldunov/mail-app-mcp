"""Collect a child process without unbounded pipes or an unbounded wait."""

import os
import selectors
import subprocess
import time

MAX_STDOUT = 2_000_000
MAX_STDERR = 32_768
CHUNK = 65_536


class ProcessCommunicationError(RuntimeError):
    """The child started, but its response could not be safely collected."""

    def __init__(self, message: str, *, stderr: bytes = b""):
        super().__init__(message)
        self.stderr = stderr[:MAX_STDERR]


class OutputLimitExceeded(ProcessCommunicationError):
    """The child exceeded its output budget and was terminated."""


def run_bounded(command: list[str], request: str, timeout: float) -> subprocess.CompletedProcess:
    with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, shell=False) as process:
        try:
            return _collect(process, command, request.encode("utf-8"), timeout)
        except OSError as exc:
            raise ProcessCommunicationError("Could not collect child output") from exc
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def _collect(process, command, request: bytes, timeout: float):
    deadline = time.monotonic() + timeout
    stdout = b""
    stderr = b""
    position = 0
    with selectors.DefaultSelector() as selector:
        for stream, events, name in ((process.stdin, selectors.EVENT_WRITE, "stdin"),
                                     (process.stdout, selectors.EVENT_READ, "stdout"),
                                     (process.stderr, selectors.EVENT_READ, "stderr")):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, events, name)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout, stderr=stderr)
            for key, _ in selector.select(remaining):
                stream = key.fileobj
                if key.data == "stdin":
                    try:
                        position += os.write(stream.fileno(), request[position:position + CHUNK])
                    except BrokenPipeError:
                        position = len(request)
                    if position == len(request):
                        selector.unregister(stream)
                        stream.close()
                    continue
                chunk = os.read(stream.fileno(), CHUNK)
                if not chunk:
                    selector.unregister(stream)
                    stream.close()
                elif key.data == "stdout":
                    stdout += chunk
                else:
                    stderr += chunk
                if len(stdout) > MAX_STDOUT or len(stderr) > MAX_STDERR:
                    raise OutputLimitExceeded("Mail automation exceeded the output budget", stderr=stderr)
    remaining = max(0, deadline - time.monotonic())
    try:
        returncode = process.wait(timeout=remaining)
    except subprocess.TimeoutExpired as exc:
        raise subprocess.TimeoutExpired(command, timeout, stderr=stderr) from exc
    try:
        output = stdout.decode("utf-8")
    except UnicodeError as exc:
        raise ProcessCommunicationError(f"Mail returned invalid UTF-8: {exc}", stderr=stderr) from exc
    return subprocess.CompletedProcess(command, returncode, output, stderr.decode("utf-8", errors="replace"))
