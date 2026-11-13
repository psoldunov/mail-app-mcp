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
        if self.fail_write:
            raise OutcomeUnknown("Do not retry")
        if operation == "create_draft":
            return {"draft_id": 12, "account_id": args["account_id"], "sender": args["sender"], "status": "draft"}
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
    with pytest.raises(Exception, match="configured"):
        call(server, "trash_message", {"ref": {**REF, "account_id": "personal"}})


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
    call(server, "create_draft", {"draft": draft, "open_window": True})
    assert mail.requests[-1][1]["open_window"] is True
    result = call(server, "show_draft", {"account_id": "work", "draft_id": 12, "sender": "work@example.org"})
    assert result["draft_id"] == 12
    assert call(server, "show_message", {"ref": REF})["ref"] == REF


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
