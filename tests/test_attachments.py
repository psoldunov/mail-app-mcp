from pathlib import Path

import pytest

from mail_app_mcp.attachments import read_attachment_content
from mail_app_mcp.models import MessageRef

REF = MessageRef(account_id="work", mailbox=["Inbox"], message_id=1, header_message_id="message")


class AttachmentMail:
    def __init__(self, content, mime="text/plain", name="../../.zshrc"):
        self.content = content
        self.mime = mime
        self.name = name
        self.export_path = None

    def call(self, operation, args):
        assert operation == "save_attachment"
        self.export_path = Path(args["path"])
        self.export_path.write_bytes(self.content)
        return {"mime_type": self.mime, "name": self.name, "size": len(self.content)}


def test_attachment_name_cannot_choose_export_location_and_file_is_cleaned(tmp_path):
    mail = AttachmentMail(b"untrusted attachment text")
    result = read_attachment_content(mail, tmp_path, REF, "attachment-1")
    assert result["text"] == "untrusted attachment text"
    assert mail.export_path.is_relative_to(tmp_path)
    assert not mail.export_path.exists()
    assert result["name"] == "../../.zshrc"


def test_binary_attachment_returns_explicit_base64(tmp_path):
    result = read_attachment_content(AttachmentMail(b"\x00\x01\xff", "application/octet-stream"), tmp_path, REF, "attachment-1")
    assert result["base64"] == "AAH/"


def test_mime_warning_survives_attachment_export(tmp_path):
    class UnavailableMimeMail(AttachmentMail):
        def call(self, operation, args):
            return {**super().call(operation, args), "warning": "MIME type unavailable from Mail"}

    result = read_attachment_content(UnavailableMimeMail(b"data", "application/octet-stream"), tmp_path, REF, "att")
    assert result["warning"] == "MIME type unavailable from Mail"
    assert result["encoding"] == "base64"


def test_attachment_size_is_checked_after_export(tmp_path):
    with pytest.raises(ValueError, match="limit"):
        read_attachment_content(AttachmentMail(b"x" * (10 * 1024 * 1024 + 1)), tmp_path, REF, "attachment-1")


def test_invalid_pdf_fails_cleanly(tmp_path):
    with pytest.raises(ValueError, match="PDF"):
        read_attachment_content(AttachmentMail(b"not pdf", "application/pdf"), tmp_path, REF, "attachment-1")


def test_valid_pdf_extracts_in_bounded_child_process(tmp_path):
    from io import BytesIO
    from pypdf import PdfWriter
    from mail_app_mcp.pdf_text import extract_pdf

    output = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.write(output)
    mail = AttachmentMail(output.getvalue(), "application/pdf")
    assert read_attachment_content(mail, tmp_path, REF, "attachment-1")["pages"] == 1
    fixture = tmp_path / "blank.pdf"
    fixture.write_bytes(output.getvalue())
    assert extract_pdf(fixture) == {"text": "", "pages": 1, "truncated": False}


def test_pdf_child_gets_the_server_import_path(tmp_path, monkeypatch):
    # Under Nix the bare interpreter cannot import this package or pypdf; only the server's sys.path can.
    import sys
    from io import BytesIO
    from pypdf import PdfWriter

    output = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.write(output)
    monkeypatch.setattr(sys, "executable", sys._base_executable)
    monkeypatch.delenv("PYTHONPATH", raising=False)
    monkeypatch.delenv("NIX_PYTHONPATH", raising=False)
    result = read_attachment_content(AttachmentMail(output.getvalue(), "application/pdf"), tmp_path, REF, "att")
    assert result["pages"] == 1


def test_pdf_child_failure_reports_its_cause(tmp_path, monkeypatch):
    import sys

    monkeypatch.setattr(sys, "path", [str(tmp_path / "nothing-here")])
    monkeypatch.delenv("NIX_PYTHONPATH", raising=False)
    monkeypatch.setattr(sys, "executable", sys._base_executable)
    with pytest.raises(ValueError, match="No module named"):
        read_attachment_content(AttachmentMail(b"%PDF-1.4", "application/pdf"), tmp_path, REF, "att")


def test_encrypted_pdf_is_explicitly_unsupported(tmp_path):
    from pypdf import PdfWriter
    from mail_app_mcp.pdf_text import extract_pdf

    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.encrypt("password")
    path = tmp_path / "encrypted.pdf"
    writer.write(path)
    with pytest.raises(ValueError, match="Encrypted"):
        extract_pdf(path)


def test_large_binary_does_not_create_unbounded_tool_result(tmp_path):
    with pytest.raises(ValueError, match="response limit"):
        read_attachment_content(AttachmentMail(b"x" * (1024 * 1024 + 1), "application/octet-stream"), tmp_path, REF, "attachment-1")
