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


@pytest.mark.parametrize("mapping,expected", [
    (b"<2B> <0000> <2D> <0000> <28> <0000> <29> <0000>", {
        "text": "INV\ufffd2026 \ufffdUsage\ufffd \ufffd$10.00", "pages": 1, "truncated": False,
        "warning": "4 characters could not be mapped; replaced with U+FFFD",
    }),
    (b"<2B> <002B> <2D> <002D> <28> <0028> <29> <0029>", {
        "text": "INV-2026 (Usage) +$10.00", "pages": 1, "truncated": False,
    }),
])
def test_pdf_worker_preserves_readable_text_and_warns_about_unmapped_glyphs(tmp_path, mapping, expected):
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
    from mail_app_mcp.pdf_text import extract_pdf

    # Synthetic invoice: identical visible glyphs with valid or broken Unicode mappings.
    writer = PdfWriter()
    page = writer.add_blank_page(width=400, height=100)
    cmap = DecodedStreamObject()
    cmap.set_data(b"""/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Synthetic def /CMapType 2 def
1 begincodespacerange <00> <FF> endcodespacerange
4 beginbfchar """ + mapping + b""" endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end""")
    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
        NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
        NameObject("/ToUnicode"): writer._add_object(cmap),
    })
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)}),
    })
    stream = DecodedStreamObject()
    stream.set_data(br"BT /F1 12 Tf 20 50 Td (INV-2026 \(Usage\) +$10.00) Tj ET")
    page[NameObject("/Contents")] = writer._add_object(stream)
    path = tmp_path / "invoice.pdf"
    writer.write(path)

    result = subprocess.run(
        [sys.executable, "-m", "mail_app_mcp.pdf_text", str(path)],
        capture_output=True, text=True, timeout=10,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == expected
    assert extract_pdf(path) == expected
    from mail_app_mcp.attachments import extract_content
    assert extract_content(path, "application/pdf") == expected
