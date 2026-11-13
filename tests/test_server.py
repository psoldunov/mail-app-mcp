import asyncio
import json

import pytest

from mail_app_mcp.bridge import OutcomeUnknown
from mail_app_mcp.models import Settings
from mail_app_mcp.server import create_server
from mail_app_mcp.bridge import BridgeError
from mcp.shared.memory import create_connected_server_and_client_session


REF = {"account_id": "work", "mailbox": ["Inbox"], "message_id": 7, "header_message_id": "msg@example.org"}


class FixtureMail:
    def __init__(self):
        self.requests = []
        self.fail_write = False

    def call(self, operation, args):
        self.requests.append((operation, args))
        if operation == "list_accounts":
            return {"accounts": [
                {"account_id": "work", "name": "Mail", "email_addresses": ["work@example.org"]},
                {"account_id": "personal", "name": "Mail", "email_addresses": ["home@example.org"]},
            ]}
        if operation == "trash_destination":
            return {"account_id": args["account_id"], "destination": ["Deleted Items"]}
        if self.fail_write:
            raise OutcomeUnknown("Do not retry")
        if operation == "create_draft":
            return {"status": "draft", "account_id": args["account_id"], "sender": args["sender"],
                    "ref": {**REF, "mailbox": ["Drafts"], "message_id": 12}}
        return {"operation": operation, **args}


def call(server, name, arguments):
    result = asyncio.run(server.call_tool(name, arguments))
    if isinstance(result, dict):
        return result
    if isinstance(result, tuple):
        return result[1]
    return json.loads(result[0].text)


def test_multiaccount_discovery_and_no_forbidden_tools(tmp_path):
    server = create_server(bridge=FixtureMail(), state_dir=tmp_path)
    accounts = call(server, "list_accounts", {})["accounts"]
    assert [a["account_id"] for a in accounts] == ["work", "personal"]
    names = {tool.name for tool in asyncio.run(server.list_tools())}
    assert {"create_draft", "trash_message", "read_attachment"} <= names
    assert not names & {"send", "send_email", "delete", "delete_message", "run_script", "empty_trash"}


def test_draft_uses_explicit_account_and_rejects_foreign_sender(tmp_path):
    mail = FixtureMail()
    server = create_server(bridge=mail, state_dir=tmp_path)
    draft = {"account_id": "work", "sender": "work@example.org", "to": ["recipient@example.org"], "subject": "Hi", "body": "draft"}
    assert call(server, "create_draft", {"draft": draft})["status"] == "draft"
    with pytest.raises(Exception, match="sender|Sender"):
        call(server, "create_draft", {"draft": {**draft, "sender": "home@example.org"}})
    assert len([op for op, _ in mail.requests if op == "create_draft"]) == 1


def test_trash_moves_only_to_owners_configured_account_mailbox(tmp_path):
    mail = FixtureMail()
    settings = Settings.model_validate({"accounts": {"work": {"trash_mailbox": ["Deleted Messages"]}}})
    server = create_server(settings, mail, tmp_path)
    assert call(server, "trash_message", {"ref": REF})["destination"] == ["Deleted Messages"]
    assert mail.requests[-1][0] == "move_message"
    assert call(server, "trash_message", {"ref": {**REF, "account_id": "personal"}})["destination"] == ["Deleted Items"]


def test_default_moves_and_discovered_trash_respect_explicit_restrictions(tmp_path):
    mail = FixtureMail()
    server = create_server(bridge=mail, state_dir=tmp_path)
    assert call(server, "move_message", {"ref": REF, "destination": ["Archive"]})["destination"] == ["Archive"]
    assert call(server, "trash_message", {"ref": REF})["destination"] == ["Deleted Items"]
    settings = Settings.model_validate({"accounts": {"work": {"allowed_destinations": []}}})
    restricted = create_server(settings, mail, tmp_path)
    writes_before = len([op for op, _ in mail.requests if op == "move_message"])
    with pytest.raises(Exception, match="configured"):
        call(restricted, "trash_message", {"ref": REF})
    assert len([op for op, _ in mail.requests if op == "move_message"]) == writes_before


@pytest.mark.parametrize("discovered", [
    {"account_id": "personal", "destination": ["Trash"]},
    {"account_id": "work", "destination": []},
    {"account_id": "work", "destination": ["Outbox"]},
])
def test_invalid_trash_discovery_never_attempts_write(tmp_path, discovered):
    class InvalidTrash(FixtureMail):
        def call(self, operation, args):
            if operation == "trash_destination":
                return discovered
            return super().call(operation, args)
    mail = InvalidTrash()
    with pytest.raises(Exception):
        call(create_server(bridge=mail, state_dir=tmp_path), "trash_message", {"ref": REF})
    assert not mail.requests
    assert not list(tmp_path.glob("write-uncertain*"))


def test_read_message_preserves_html_link_targets_without_exposing_source(tmp_path):
    from email.message import EmailMessage

    source = EmailMessage()
    source.set_content("See the requests here")
    source.add_alternative('<p>See <a href="https://example.org/dashboard?a=1&amp;b=2">the <b>requests</b> here</a>'
                           '<a href="javascript:alert(1)">unsafe</a></p>', subtype="html", cte="base64")

    class LinkedMail(FixtureMail):
        def call(self, operation, args):
            return {"body": "See the requests here", "source": source.as_string(), "source_truncated": False}

    result = call(create_server(bridge=LinkedMail(), state_dir=tmp_path), "read_message", {"ref": REF})
    assert result["links"] == [{"url": "https://example.org/dashboard?a=1&b=2", "text": "the requests here"}]
    assert result["body"] == "See the requests here"
    assert result["links_truncated"] is False
    assert "source" not in result and "source_truncated" not in result


@pytest.mark.parametrize(("source", "truncated", "expected_incomplete"), [
    (None, False, True),
    ("Content-Type: text/plain\n\nNo links", False, False),
    ("Content-Type: text/html\n\n<a href='https://example.org'>partial", True, True),
    ("x" * 100_001, False, True),
    ("Content-Type: text/html; charset=made-up-charset\n\n<a href='https://example.org'>x</a>", False, True),
])
def test_read_message_reports_incomplete_link_extraction(tmp_path, source, truncated, expected_incomplete):
    class SourceMail(FixtureMail):
        def call(self, operation, args):
            return {"source": source, "source_truncated": truncated}

    result = call(create_server(bridge=SourceMail(), state_dir=tmp_path), "read_message", {"ref": REF})
    assert result["links"] == []
    assert result["links_truncated"] is expected_incomplete
    assert "source" not in result


def test_read_message_keeps_complete_links_from_truncated_mime_with_small_body_budget(tmp_path):
    class SourceMail(FixtureMail):
        def call(self, operation, args):
            return {"body": "x" * args["max_chars"], "source_truncated": True,
                    "source": 'Content-Type: text/html\n\n<a href="https://example.org/receipt">Receipt</a>'
                              '<a href="https://example.org/cut">unfinished'}

    result = call(create_server(bridge=SourceMail(), state_dir=tmp_path), "read_message",
                  {"ref": REF, "max_chars": 1500})
    assert result["links"] == [{"url": "https://example.org/receipt", "text": "Receipt"}]
    assert result["links_truncated"] is True


@pytest.mark.parametrize("remainder", range(4))
def test_read_message_keeps_links_before_each_base64_cut_boundary(tmp_path, remainder):
    import base64

    html = b'<a href="https://example.org/receipt">Receipt</a>' + b'x' * 1000
    prefix = base64.b64encode(html).decode()[:400 + remainder]

    class SourceMail(FixtureMail):
        def call(self, operation, args):
            return {"source": 'Content-Type: text/html; charset=utf-8\n'
                              'Content-Transfer-Encoding: base64\n\n' + prefix,
                    "source_truncated": True}

    result = call(create_server(bridge=SourceMail(), state_dir=tmp_path), "read_message",
                  {"ref": REF, "max_chars": 1500})
    assert result["links"] == [{"url": "https://example.org/receipt", "text": "Receipt"}]
    assert result["links_truncated"] is True


def test_read_message_bounds_links_and_ignores_html_attachments(tmp_path):
    from email.message import EmailMessage

    source = EmailMessage()
    source.set_content("plain")
    source.add_alternative("".join(f'<a href="https://example.org/{i}">{"x" * 300}</a>' for i in range(101)), subtype="html")
    source.add_attachment('<a href="https://attachment.org">attached</a>', subtype="html", filename="attached.html")

    class ManyLinks(FixtureMail):
        def call(self, operation, args):
            return {"source": source.as_string()}

    result = call(create_server(bridge=ManyLinks(), state_dir=tmp_path), "read_message", {"ref": REF})
    assert len(result["links"]) == 100
    assert result["links"][0] == {"url": "https://example.org/0", "text": "x" * 256}
    assert result["links"][-1]["url"] == "https://example.org/99"
    assert result["links_truncated"] is True


def test_deeply_nested_mime_does_not_hide_plain_body(tmp_path):
    source = "Content-Type: text/html\n\n<a href='https://example.org'>link</a>"
    for index in range(1200):
        source = f'Content-Type: multipart/mixed; boundary="b{index}"\n\n--b{index}\n{source}\n--b{index}--\n'
    # Nested MIME can exhaust recursion despite being below the source size limit.
    assert len(source) < 100_000

    class NestedMail(FixtureMail):
        def call(self, operation, args):
            return {"source": source, "body": "Still readable"}

    result = call(create_server(bridge=NestedMail(), state_dir=tmp_path), "read_message", {"ref": REF})
    assert result["body"] == "Still readable"
    assert result["links"] == [] and result["links_truncated"] is True


def test_unknown_write_outcome_blocks_following_writes(tmp_path):
    mail = FixtureMail()
    server = create_server(bridge=mail, state_dir=tmp_path)
    mail.fail_write = True
    with pytest.raises(Exception, match="retry"):
        call(server, "set_message_status", {"ref": REF, "read": True})
    mail.fail_write = False
    with pytest.raises(Exception, match="uncertain"):
        call(server, "set_message_status", {"ref": REF, "read": False})
    assert len(mail.requests) == 1


def test_uncertainty_is_isolated_to_the_server_session(tmp_path):
    mail = FixtureMail()
    first = create_server(bridge=mail, state_dir=tmp_path)
    second = create_server(bridge=mail, state_dir=tmp_path)
    mail.fail_write = True
    with pytest.raises(Exception, match="retry"):
        call(first, "set_message_status", {"ref": REF, "read": True})
    mail.fail_write = False
    assert call(second, "set_message_status", {"ref": REF, "read": False})
    with pytest.raises(Exception, match="uncertain"):
        call(first, "set_message_status", {"ref": REF, "read": False})
    restarted = create_server(bridge=mail, state_dir=tmp_path)
    assert call(restarted, "set_message_status", {"ref": REF, "read": True})
    assert len(mail.requests) == 3


def test_uncertain_write_errors_explain_manual_recovery_and_reads_still_work(tmp_path):
    mail = FixtureMail()
    server = create_server(bridge=mail, state_dir=tmp_path)
    mail.fail_write = True
    with pytest.raises(Exception) as initial:
        call(server, "set_message_status", {"ref": REF, "read": True})
    mail.fail_write = False
    with pytest.raises(Exception) as blocked:
        call(server, "set_message_status", {"ref": REF, "read": False})
    for error in (initial, blocked):
        assert str(tmp_path / "write-uncertain") in str(error.value)
        assert "Inspect Mail" in str(error.value)
        assert "mail-app-mcp --clear-uncertain" in str(error.value)
        assert "writes.lock" in str(error.value)
        assert "only in this MCP server session" in str(error.value)
        assert "does not confirm or cancel" in str(error.value)
    assert len(mail.requests) == 1
    assert call(server, "read_message", {"ref": REF})["operation"] == "read_message"
    assert len(list(tmp_path.glob("write-uncertain-*"))) == 1


def test_uncertain_marker_records_and_reports_what_was_attempted(tmp_path):
    mail = FixtureMail()
    server = create_server(bridge=mail, state_dir=tmp_path)
    mail.fail_write = True
    with pytest.raises(Exception):
        call(server, "set_message_status", {"ref": REF, "read": True})
    marker, = tmp_path.glob("write-uncertain-*")
    record = json.loads(marker.read_text())
    assert record["operation"] == "set_message_status"
    assert record["target"] == REF
    assert record["pid"] > 0 and record["started_at"] and record["build"]
    draft = {"account_id": "work", "sender": "work@example.org", "to": ["a@example.org"], "subject": "Hi", "body": "x"}
    with pytest.raises(Exception) as blocked:
        call(server, "create_draft", {"draft": draft})
    assert '"operation": "set_message_status"' in str(blocked.value)
    assert '"message_id": 7' in str(blocked.value)


def test_legacy_marker_is_preserved_but_does_not_block_new_sessions(tmp_path):
    (tmp_path / "write-uncertain").touch(mode=0o600)
    tmp_path.chmod(0o700)
    server = create_server(bridge=FixtureMail(), state_dir=tmp_path)
    assert call(server, "set_message_status", {"ref": REF, "read": True})
    assert (tmp_path / "write-uncertain").exists()


def test_owner_clears_the_marker_from_the_command_line(tmp_path, monkeypatch, capsys):
    from mail_app_mcp import server as module

    monkeypatch.setattr(module, "DEFAULT_STATE_DIR", tmp_path)
    monkeypatch.setattr("sys.argv", ["mail-app-mcp", "--clear-uncertain"])
    module.main()
    assert "No uncertain write" in capsys.readouterr().out
    mail = FixtureMail()
    servers = [create_server(bridge=mail, state_dir=tmp_path) for _ in range(2)]
    mail.fail_write = True
    for server in servers:
        with pytest.raises(Exception):
            call(server, "set_message_status", {"ref": REF, "read": True})
    (tmp_path / "write-uncertain").touch(mode=0o600)
    unrelated = tmp_path / "owner-notes"
    unrelated.write_text("keep")
    lock_inode = (tmp_path / "writes.lock").stat().st_ino
    module.main()
    output = capsys.readouterr().out
    assert output.count('"operation": "set_message_status"') == 2
    assert "no details recorded" in output
    assert not list(tmp_path.glob("write-uncertain*"))
    assert unrelated.read_text() == "keep"
    assert (tmp_path / "writes.lock").stat().st_ino == lock_inode
    mail.fail_write = False
    for server in servers:
        assert call(server, "set_message_status", {"ref": REF, "read": True})


def test_show_message_is_serialized_but_never_marks_or_waits_on_uncertainty(tmp_path):
    mail = FixtureMail()
    server = create_server(bridge=mail, state_dir=tmp_path)
    mail.fail_write = True
    with pytest.raises(Exception):
        call(server, "show_message", {"ref": REF})
    assert not list(tmp_path.glob("write-uncertain*"))
    with pytest.raises(Exception):
        call(server, "set_message_status", {"ref": REF, "read": True})
    mail.fail_write = False
    assert call(server, "show_message", {"ref": REF})["ref"] == REF
    tool = next(tool for tool in asyncio.run(server.list_tools()) if tool.name == "show_message")
    assert tool.annotations.destructiveHint is False


def test_each_call_logs_its_name_and_duration_but_never_its_arguments(tmp_path, caplog):
    caplog.set_level("INFO", logger="mail_app_mcp")
    mail = FixtureMail()
    server = create_server(bridge=mail, state_dir=tmp_path)
    call(server, "read_message", {"ref": REF})
    mail.fail_write = True
    with pytest.raises(Exception):
        call(server, "set_message_status", {"ref": REF, "read": True})
    lines = [record.getMessage() for record in caplog.records if record.name == "mail_app_mcp"]
    assert [line.split()[:2] for line in lines] == [
        ["queued", "read_message"], ["start", "read_message"], ["end", "read_message"],
        ["queued", "set_message_status"], ["start", "set_message_status"], ["fail", "set_message_status"]]
    assert lines[-1].endswith("OutcomeUnknown")
    assert not any("msg@example.org" in line for line in lines)


def test_read_message_restores_own_address_recipients_and_attachment_types(tmp_path):
    class HeaderMail(FixtureMail):
        def call(self, operation, args):
            return {"ref": REF, "to": [], "cc": ["Other@Example.org"], "body": "",
                    "headers": ("To: =?utf-8?q?M=C3=A9?= <me@example.org>\nCc: other@example.org,\n"
                                " \"Doe, Jane\" <jane@example.org>\nBcc: hidden@example.org\nSubject: x\n"),
                    "attachments": [
                        {"name": "report.pdf", "mime_type": "application/octet-stream", "warning": "unavailable"},
                        {"name": "blob.bin", "mime_type": "application/octet-stream"},
                        {"name": "logo.png", "mime_type": "image/png"},
                    ]}

    result = call(create_server(bridge=HeaderMail(), state_dir=tmp_path), "read_message", {"ref": REF})
    assert "headers" not in result
    assert result["to"] == ["me@example.org"]
    assert result["cc"] == ["Other@Example.org", "jane@example.org"]
    assert result["bcc"] == ["hidden@example.org"]
    assert [item["mime_type"] for item in result["attachments"]] == [
        "application/pdf", "application/octet-stream", "image/png"]
    assert "guessed" in result["attachments"][0]["warning"]


def test_mail_closed_is_a_tool_error_and_connection_recovers(tmp_path):
    class StoppedMail:
        running = False

        def call(self, operation, args):
            if not self.running:
                raise BridgeError("Mail is not running. Open Mail and try again.")
            return {"accounts": []}

    async def scenario():
        mail = StoppedMail()
        async with create_connected_server_and_client_session(create_server(bridge=mail, state_dir=tmp_path)) as client:
            failed = await client.call_tool("list_accounts", {})
            assert failed.isError
            assert "not running" in failed.content[0].text
            assert (await client.list_tools()).tools
            mail.running = True
            succeeded = await client.call_tool("list_accounts", {})
            assert not succeeded.isError

    asyncio.run(scenario())


def test_read_search_and_reply_preserve_account_scope(tmp_path):
    mail = FixtureMail()
    server = create_server(bridge=mail, state_dir=tmp_path)
    assert call(server, "list_mailboxes", {"account_id": "personal"})["account_id"] == "personal"
    result = call(server, "list_messages", {"account_id": "personal", "mailbox": ["Inbox"], "query": "report"})
    assert result["account_id"] == "personal" and result["query"] == "report"
    assert call(server, "read_message", {"ref": REF})["ref"] == REF
    reply = call(server, "reply_draft", {"ref": REF, "sender": "work@example.org", "body": "Thanks"})
    assert reply["ref"] == REF and reply["sender"] == "work@example.org"


def test_move_needs_allowlist_and_rejects_noop(tmp_path):
    mail = FixtureMail()
    settings = Settings.model_validate({"accounts": {"work": {"allowed_destinations": [["Archive"], ["Inbox"]]}}})
    server = create_server(settings, mail, tmp_path)
    assert call(server, "move_message", {"ref": REF, "destination": ["Archive"]})["destination"] == ["Archive"]
    with pytest.raises(Exception, match="already"):
        call(server, "move_message", {"ref": REF, "destination": ["Inbox"]})
    with pytest.raises(Exception, match="Provide"):
        call(server, "set_message_status", {"ref": REF})


def test_denied_move_explains_allowed_paths_without_attempting_a_write(tmp_path):
    mail = FixtureMail()
    settings = Settings.model_validate({"accounts": {"work": {
        "allowed_destinations": [["Projects", "2026"]], "trash_mailbox": ["Deleted Messages"],
    }, "personal": {"allowed_destinations": []}}})
    server = create_server(settings, mail, tmp_path)
    with pytest.raises(Exception) as denied:
        call(server, "move_message", {"ref": REF, "destination": ["Inbox"]})
    assert '["Projects", "2026"]' in str(denied.value)
    assert '["Deleted Messages"]' in str(denied.value)
    assert "restart" in str(denied.value)
    with pytest.raises(Exception, match=r"Configured destinations: \[\]"):
        call(server, "move_message", {"ref": {**REF, "account_id": "personal"}, "destination": ["Inbox"]})
    assert not mail.requests
    assert not list(tmp_path.glob("write-uncertain*"))


def test_known_rejection_does_not_poison_write_lock(tmp_path):
    class RejectOnce:
        rejected = False

        def call(self, operation, args):
            if not self.rejected:
                self.rejected = True
                raise BridgeError("Message reference is stale")
            return {"read": True}

    server = create_server(bridge=RejectOnce(), state_dir=tmp_path)
    with pytest.raises(Exception, match="stale"):
        call(server, "set_message_status", {"ref": REF, "read": True})
    assert call(server, "set_message_status", {"ref": REF, "read": True}) == {"read": True}


def test_draft_can_be_shown_without_exposing_send(tmp_path):
    mail = FixtureMail()
    server = create_server(bridge=mail, state_dir=tmp_path)
    draft = {"account_id": "work", "sender": "work@example.org", "to": ["recipient@example.org"], "subject": "Hi", "body": "draft"}
    saved = call(server, "create_draft", {"draft": draft, "open_window": True})["ref"]
    assert mail.requests[-1][1]["open_window"] is True
    assert call(server, "show_message", {"ref": saved})["ref"] == saved
    assert "show_draft" not in {tool.name for tool in asyncio.run(server.list_tools())}


def test_slow_mail_does_not_block_protocol_requests(tmp_path):
    from threading import Event

    entered, release = Event(), Event()

    class SlowMail:
        def call(self, operation, args):
            entered.set()
            assert release.wait(5)
            return {"accounts": []}

    async def scenario():
        async with create_connected_server_and_client_session(create_server(bridge=SlowMail(), state_dir=tmp_path)) as client:
            request = asyncio.create_task(client.call_tool("list_accounts", {}))
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                assert (await asyncio.wait_for(client.list_tools(), 2)).tools
            finally:
                release.set()
                await request

    asyncio.run(scenario())


def test_global_search_schema_and_scope(tmp_path):
    mail = FixtureMail()
    server = create_server(bridge=mail, state_dir=tmp_path)
    result = call(server, "search_messages", {"from": "isabel", "sort": "newest", "limit": 1})
    assert result == {"operation": "search_messages", "from": "isabel", "sort": "newest",
                      "limit": 1, "account_id": None, "mailbox": None}
    tool = next(tool for tool in asyncio.run(server.list_tools()) if tool.name == "search_messages")
    assert "from" in tool.inputSchema["properties"]
    assert tool.annotations.readOnlyHint
    scoped = call(server, "search_messages", {"from": "a", "account_id": "work", "mailbox": ["Inbox"]})
    assert scoped["account_id"] == "work" and scoped["mailbox"] == ["Inbox"]
    for invalid in ({"mailbox": ["Inbox"]}, {"sort": "random"}, {"limit": 0}, {"from": "x" * 1001}):
        before = len(mail.requests)
        with pytest.raises(Exception):
            call(server, "search_messages", invalid)
        assert len(mail.requests) == before
