import json
import subprocess
import sys

import pytest
from pypdf import PdfWriter


def test_pdf_worker_starts_and_extracts_a_valid_document(tmp_path):
    path = tmp_path / "blank.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.write(path)

    result = subprocess.run(
        [sys.executable, "-m", "mail_app_mcp.pdf_text", str(path)],
        capture_output=True, text=True, timeout=10,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"text": "", "pages": 1, "truncated": False}


@pytest.mark.skipif(sys.platform != "darwin", reason="Darwin RSS watchdog")
def test_pdf_worker_terminates_parser_exceeding_rss_ceiling():
    result = subprocess.run(
        [sys.executable, "-c", """
import resource
import time
import pypdf
from mail_app_mcp import pdf_text

def oversized_reader(path):
    assert resource.getrlimit(resource.RLIMIT_CPU) == (5, 5)
    print('parser started with CPU limit', flush=True)
    allocation = b'x' * (64 * 1024 * 1024)
    time.sleep(2)
    print('memory ceiling was not enforced', flush=True)

pypdf.PdfReader = oversized_reader
pdf_text.MAX_MEMORY = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss + 32 * 1024 * 1024
pdf_text.main()
""", "unused.pdf"],
        capture_output=True, text=True, timeout=10,
    )

    assert result.returncode == 1, result.stderr
    assert result.stdout == "parser started with CPU limit\n"
