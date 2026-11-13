import subprocess
import sys

import pytest

from mail_app_mcp.process import OutputLimitExceeded, run_bounded


def test_process_reads_input_and_separates_stderr():
    result = run_bounded([sys.executable, "-c", "import sys; print(sys.stdin.read()); print('diagnostic', file=sys.stderr)"], "input", timeout=5)
    assert result.stdout == "input\n" and result.returncode == 0
    assert result.stderr == "diagnostic\n"


@pytest.mark.parametrize("stream", ["stdout", "stderr"])
def test_process_stops_as_output_exceeds_budget(stream):
    program = f"import sys; sys.{stream}.write('x' * 3000000); sys.{stream}.flush()"
    with pytest.raises(OutputLimitExceeded):
        run_bounded([sys.executable, "-c", program], "", timeout=5)


def test_stuck_child_has_a_deadline_and_is_reaped():
    with pytest.raises(subprocess.TimeoutExpired):
        run_bounded([sys.executable, "-c", "import time; time.sleep(30)"], "input", timeout=0.1)


@pytest.mark.parametrize("close_pipes", [False, True])
def test_timeout_preserves_stderr_diagnostics(close_pipes):
    program = "import os,sys,time; sys.stderr.write('Mail is starting'); sys.stderr.flush(); "
    if close_pipes:
        program += "os.close(0); os.close(1); os.close(2); "
    with pytest.raises(subprocess.TimeoutExpired) as caught:
        run_bounded([sys.executable, "-c", program + "time.sleep(30)"], "", timeout=0.2)
    assert caught.value.stderr == b"Mail is starting"


@pytest.mark.parametrize("output", ["b'x' * 3000000", "b'\\xff'"])
def test_invalid_output_preserves_already_collected_stderr(output):
    from mail_app_mcp.process import ProcessCommunicationError

    program = ("import sys,time; sys.stderr.write('Apple event denied (-1743)'); "
               "sys.stderr.flush(); time.sleep(0.05); "
               f"sys.stdout.buffer.write({output})")
    with pytest.raises(ProcessCommunicationError) as caught:
        run_bounded([sys.executable, "-c", program], "", timeout=5)
    assert caught.value.stderr == b"Apple event denied (-1743)"
