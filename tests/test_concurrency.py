import subprocess
import sys

import pytest

from mail_app_mcp.bridge import BridgeError, write_lock


def test_other_process_cannot_enter_the_write_critical_section(tmp_path):
    program = """
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('blocked')
else:
    print('acquired')
finally:
    os.close(fd)
"""
    lock = str(tmp_path / "writes.lock")
    with write_lock(tmp_path):
        result = subprocess.run([sys.executable, "-c", program, lock], capture_output=True, text=True, timeout=5, check=True)
        assert result.stdout.strip() == "blocked"
    result = subprocess.run([sys.executable, "-c", program, lock], capture_output=True, text=True, timeout=5, check=True)
    assert result.stdout.strip() == "acquired"


def test_unsafe_existing_lock_is_rejected(tmp_path):
    lock = tmp_path / "writes.lock"
    lock.touch(mode=0o644)
    with pytest.raises(BridgeError, match="permissions"):
        with write_lock(tmp_path):
            pytest.fail("unsafe lock was accepted")
