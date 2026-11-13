import subprocess
import sys

import pytest

from mail_app_mcp.process import OutputLimitExceeded, run_bounded


def test_process_reads_input_and_separates_stderr():
    result = run_bounded([sys.executable, "-c", "import sys; print(sys.stdin.read()); print('diagnostic', file=sys.stderr)"], "input", timeout=5)
    assert result.stdout == "input\n" and result.returncode == 0


@pytest.mark.parametrize("stream", ["stdout", "stderr"])
def test_process_stops_as_output_exceeds_budget(stream):
    program = f"import sys; sys.{stream}.write('x' * 3000000); sys.{stream}.flush()"
    with pytest.raises(OutputLimitExceeded):
        run_bounded([sys.executable, "-c", program], "", timeout=5)


def test_stuck_child_has_a_deadline_and_is_reaped():
    with pytest.raises(subprocess.TimeoutExpired):
        run_bounded([sys.executable, "-c", "import time; time.sleep(30)"], "input", timeout=0.1)
