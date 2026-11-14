"""search_messages answered from a made-up copy of Mail's index, with Mail replaced by a fake."""

import base64
import json
import sqlite3
from datetime import datetime

import pytest

from mail_app_mcp.bridge import BridgeError
from mail_app_mcp.server import create_server

from test_server import call

WORK = "AAAAAAAA-0000-0000-0000-000000000001"
HOME = "BBBBBBBB-0000-0000-0000-000000000002"
BOXES = {
    1: f"imap://{WORK}/%5BGmail%5D/All%20Mail",
    2: f"imap://{WORK}/INBOX",
    3: f"imap://{WORK}/%5BGmail%5D/Important",
    4: f"imap://{HOME}/INBOX",
    5: "local://CCCCCCCC-0000-0000-0000-000000000003/Outbox",
}


def make_index(root, messages, labels=(), boxes=BOXES):
    """Messages are (id, mailbox, name, address, subject, received, read, flagged, deleted)."""
    folder = root / "V10" / "MailData"
    folder.mkdir(parents=True)
    db = sqlite3.connect(folder / "Envelope Index")
    db.executescript("""
        CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT NOT NULL);
        CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT NOT NULL, comment TEXT NOT NULL,
            UNIQUE(address, comment));
        CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT NOT NULL UNIQUE);
        CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, sender INTEGER, subject_prefix TEXT,
            subject INTEGER NOT NULL, date_received INTEGER, mailbox INTEGER NOT NULL,
            read INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE labels (message_id INTEGER, mailbox_id INTEGER, PRIMARY KEY(message_id, mailbox_id)) WITHOUT ROWID;
    """)
    db.executemany("INSERT INTO mailboxes VALUES (?, ?)", boxes.items())
    db.executemany("INSERT INTO labels VALUES (?, ?)", labels)
    db.commit()
    db.close()
    return arrive(root, messages)


def arrive(root, messages):
    """Adds messages to an index made by make_index, as Mail does while it runs."""
    db = sqlite3.connect(root / "V10" / "MailData" / "Envelope Index")
    for rowid, box, name, address, subject, received, read, flagged, deleted in messages:
        db.execute("INSERT OR IGNORE INTO addresses (address, comment) VALUES (?, ?)", (address, name))
        db.execute("INSERT OR IGNORE INTO subjects (subject) VALUES (?)", (subject,))
        db.execute(
            "INSERT INTO messages VALUES (?, (SELECT ROWID FROM addresses WHERE address = ? AND comment = ?), '',"
            " (SELECT ROWID FROM subjects WHERE subject = ?), ?, ?, ?, ?, ?)",
            (rowid, address, name, subject, int(datetime.fromisoformat(received).timestamp()), box,
             read, flagged, deleted))
    db.commit()
    db.close()
    return root


class FakeMail:
    """Confirms every nominated message, and answers a scan with a recognisable marker."""

    def __init__(self):
        self.requests = []

    def call(self, operation, args):
        self.requests.append((operation, args))
        if operation == "confirm_messages":
            return {"header_message_ids": [f"header-{item['message_id']}" for item in args["messages"]]}
        return {"messages": [], "scanned_by_mail": True}

    def operations(self):
        return [operation for operation, _ in self.requests]


def search(tmp_path, messages, arguments, labels=(), mail=None, boxes=BOXES):
    mail = mail or FakeMail()
    index = make_index(tmp_path / "Mail", messages, labels, boxes)
    server = create_server(bridge=mail, state_dir=tmp_path / "state", mail_data=index)
    return call(server, "search_messages", arguments), mail


def test_newest_sender_match_across_accounts_comes_from_the_index(tmp_path):
    result, mail = search(tmp_path, [
        (10, 1, "Isabel Ortiz", "isabel@example.org", "Older", "2026-11-01T10:00:00+00:00", 1, 0, 0),
        (11, 1, "Someone Else", "other@example.org", "Newest but wrong sender", "2026-11-13T10:00:00+00:00", 0, 0, 0),
        (12, 4, "Isabel Ortiz", "isabel@example.org", "Latest", "2026-11-12T08:30:00+00:00", 0, 1, 0),
    ], {"from": "ISABEL", "sort": "newest", "limit": 1})

    assert result["messages"] == [{
        "ref": {"account_id": HOME, "mailbox": ["INBOX"], "message_id": 12, "header_message_id": "header-12"},
        "subject": "Latest", "sender": "Isabel Ortiz <isabel@example.org>",
        "date_received": "2026-11-12T08:30:00.000Z", "read": False, "flagged": True,
    }]
    assert result["backend"] == "index" and result["complete"] is True and result["has_more"] is True
    assert result["sort"] == "newest" and result["mailboxes_searched"] == 5
    assert mail.operations() == ["confirm_messages"]
    assert mail.requests[0][1] == {"messages": [
        {"account_id": HOME, "mailbox": ["INBOX"], "message_id": 12, "timestamp": 1794472200000}]}


ISABEL = (10, 4, "Isabel Ortiz", "isabel@example.org", "Hello", "2026-11-01T10:00:00+00:00", 0, 0, 0)
SCAN_REQUEST = ("search_messages", {"from": "isabel", "sort": "newest", "limit": 1, "account_id": None, "mailbox": None,
                                    "after": None})


def test_without_a_usable_index_mail_scans_as_before_and_says_why(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    damaged = tmp_path / "damaged"
    (damaged / "V10" / "MailData").mkdir(parents=True)
    sqlite3.connect(damaged / "V10" / "MailData" / "Envelope Index").close()
    half = tmp_path / "half"
    (half / "V10").mkdir(parents=True)
    exchange = make_index(tmp_path / "exchange", [ISABEL], boxes={**BOXES, 6: f"ews://{HOME}/Inbox"})
    for mail_data in (None, tmp_path / "absent", empty, damaged, half, exchange):
        mail = FakeMail()
        server = create_server(bridge=mail, state_dir=tmp_path / "state", mail_data=mail_data)
        result = call(server, "search_messages", {"from": "isabel", "limit": 1})
        assert result["scanned_by_mail"] is True and result["backend"] == "scan"
        assert isinstance(result["index_unavailable"], str) and result["index_unavailable"]
        assert mail.requests == [SCAN_REQUEST]


def test_a_result_mail_does_not_confirm_sends_the_search_to_the_scan(tmp_path):
    class Unconfirming(FakeMail):
        def call(self, operation, args):
            if operation != "confirm_messages":
                return super().call(operation, args)
            self.requests.append((operation, args))
            return {"header_message_ids": [None]}

    result, mail = search(tmp_path, [ISABEL], {"from": "isabel", "limit": 1}, mail=Unconfirming())
    assert result["backend"] == "scan" and "confirm" in result["index_unavailable"]
    assert mail.operations() == ["confirm_messages", "search_messages"]


def test_a_mail_failure_while_confirming_is_reported_not_retried_as_a_scan(tmp_path):
    class Starting(FakeMail):
        def call(self, operation, args):
            self.requests.append((operation, args))
            raise BridgeError("Mail is starting; no operation was attempted", operation=operation)

    mail = Starting()
    with pytest.raises(Exception, match="Mail is starting"):
        search(tmp_path, [ISABEL], {"from": "isabel", "limit": 1}, mail=mail)
    assert mail.operations() == ["confirm_messages"]


def test_no_match_answers_without_asking_mail(tmp_path):
    result, mail = search(tmp_path, [ISABEL], {"from": "nobody"})
    assert result["messages"] == [] and result["backend"] == "index" and result["has_more"] is False
    assert mail.requests == []


def stored(rowid, box, received, name="Isabel Ortiz", address="isabel@example.org", deleted=0):
    return (rowid, box, name, address, f"Subject {rowid}", received, 0, 0, deleted)


def refs(result):
    return [(m["ref"]["account_id"], m["ref"]["mailbox"], m["ref"]["message_id"]) for m in result["messages"]]


GMAIL = [stored(20, 1, "2026-11-05T00:00:00+00:00"), stored(21, 1, "2026-11-04T00:00:00+00:00"),
         stored(22, 1, "2026-11-03T00:00:00+00:00"), stored(23, 4, "2026-11-02T00:00:00+00:00"),
         stored(24, 5, "2026-11-01T00:00:00+00:00")]
# 20 sits under INBOX and Important, 21 only under Important, 22 has no label beyond All Mail.
LABELS = [(20, 3), (20, 2), (21, 3)]


def test_a_gmail_message_is_listed_once_under_inbox_then_another_label_then_all_mail(tmp_path):
    result, _ = search(tmp_path, GMAIL, {}, labels=LABELS)
    assert refs(result) == [(WORK, ["INBOX"], 20), (WORK, ["[Gmail]", "Important"], 21),
                            (WORK, ["[Gmail]", "All Mail"], 22), (HOME, ["INBOX"], 23), ("__local__", ["Outbox"], 24)]


def test_scope_narrows_to_one_account_or_one_mailbox_and_refs_keep_that_mailbox(tmp_path):
    index = make_index(tmp_path / "Mail", GMAIL, LABELS, {**BOXES, 6: f"ews://{HOME}/Inbox"})
    mail = FakeMail()
    server = create_server(bridge=mail, state_dir=tmp_path / "state", mail_data=index)

    account = call(server, "search_messages", {"account_id": WORK})
    assert refs(account) == [(WORK, ["INBOX"], 20), (WORK, ["[Gmail]", "Important"], 21), (WORK, ["[Gmail]", "All Mail"], 22)]
    assert account["mailboxes_searched"] == 3 and account["backend"] == "index"

    label = call(server, "search_messages", {"account_id": WORK, "mailbox": ["[Gmail]", "Important"]})
    assert refs(label) == [(WORK, ["[Gmail]", "Important"], 20), (WORK, ["[Gmail]", "Important"], 21)]
    assert label["mailboxes_searched"] == 1
    everything = call(server, "search_messages", {"account_id": WORK, "mailbox": ["[Gmail]", "All Mail"]})
    assert refs(everything) == [(WORK, ["[Gmail]", "All Mail"], rowid) for rowid in (20, 21, 22)]

    assert refs(call(server, "search_messages", {"account_id": "__local__"})) == [("__local__", ["Outbox"], 24)]

    # What the index does not hold or cover is left to Mail, which reports a missing account or mailbox itself.
    for arguments in ({"account_id": "missing"}, {"account_id": WORK, "mailbox": ["Nowhere"]}, {"account_id": HOME}, {}):
        assert call(server, "search_messages", arguments)["backend"] == "scan"


def ids(result):
    return [m["ref"]["message_id"] for m in result["messages"]]


def test_equal_dates_order_by_account_then_mail_id_and_deleted_mail_is_left_out(tmp_path):
    same = "2026-11-05T00:00:00+00:00"
    index = make_index(tmp_path / "Mail", [
        stored(39, 4, same), stored(31, 1, same), stored(32, 1, same), stored(33, 5, same),
        stored(34, 1, "2026-11-06T00:00:00+00:00"), stored(35, 1, "2026-11-07T00:00:00+00:00", deleted=1)])
    server = create_server(bridge=FakeMail(), state_dir=tmp_path / "state", mail_data=index)
    # On My Mac sorts before account IDs; within one account the higher Mail ID is the later arrival.
    assert ids(call(server, "search_messages", {"sort": "newest"})) == [34, 33, 32, 31, 39]
    assert ids(call(server, "search_messages", {"sort": "oldest"})) == [33, 31, 32, 39, 34]
    limited = call(server, "search_messages", {"sort": "newest", "limit": 2})
    assert ids(limited) == [34, 33] and limited["has_more"] is True
    assert call(server, "search_messages", {"limit": 5})["has_more"] is False


def test_from_matches_the_sender_text_mail_shows_without_regard_to_case(tmp_path):
    index = make_index(tmp_path / "Mail", [
        stored(50, 1, "2026-11-01T00:00:00+00:00", "Acme, Inc.", "billing@acme.example"),
        stored(51, 1, "2026-11-02T00:00:00+00:00", "", "bare@example.org"),
        stored(52, 1, "2026-11-03T00:00:00+00:00", "Émile Zola", "emile@example.org")])
    server = create_server(bridge=FakeMail(), state_dir=tmp_path / "state", mail_data=index)
    senders = {m["ref"]["message_id"]: m["sender"] for m in call(server, "search_messages", {})["messages"]}
    assert senders == {50: '"Acme, Inc." <billing@acme.example>', 51: "bare@example.org",
                       52: "Émile Zola <emile@example.org>"}
    for needle, expected in (("acme, inc", [50]), ('inc." <billing', [50]), ("BARE@", [51]), ("ÉMILE", [52]),
                             ("zola <emile", [52]), ("example", [52, 51, 50]), ("%", []), ("_", [])):
        assert ids(call(server, "search_messages", {"from": needle})) == expected, needle


SAME = "2026-11-05T00:00:00+00:00"
# Four messages share one received time across On My Mac (33), WORK (31, 32) and HOME (39).
TIED = [stored(39, 4, SAME), stored(31, 1, SAME), stored(32, 1, SAME), stored(33, 5, SAME),
        stored(34, 1, "2026-11-06T00:00:00+00:00")]


def pages(server, arguments):
    """Follows next_cursor until the last page; returns each page's Mail IDs."""
    found, cursor = [], None
    for _ in range(10):
        page = call(server, "search_messages", {**arguments, **({"cursor": cursor} if cursor else {})})
        found.append(ids(page))
        assert (page["next_cursor"] is not None) == page["has_more"]
        cursor = page["next_cursor"]
        if cursor is None:
            return found
    pytest.fail("next_cursor never ran out")


@pytest.mark.parametrize("sort, expected", [("newest", [[34, 33], [32, 31], [39]]),
                                            ("oldest", [[33, 31], [32, 39], [34]])])
def test_pages_follow_next_cursor_with_no_overlap_or_gap_through_equal_dates(tmp_path, sort, expected):
    server = create_server(bridge=FakeMail(), state_dir=tmp_path / "state", mail_data=make_index(tmp_path / "Mail", TIED))
    assert pages(server, {"sort": sort, "limit": 2}) == expected
    assert sum(expected, []) == ids(call(server, "search_messages", {"sort": sort, "limit": 10}))


def test_mail_arriving_between_pages_neither_repeats_nor_skips_a_message(tmp_path):
    index = make_index(tmp_path / "Mail", TIED)
    server = create_server(bridge=FakeMail(), state_dir=tmp_path / "state", mail_data=index)
    first = call(server, "search_messages", {"limit": 2})
    assert ids(first) == [34, 33]
    # A newer message would push an offset page back by one; one dated like the cursor but sorting after it is still due.
    arrive(index, [stored(40, 1, "2026-11-07T00:00:00+00:00"), stored(41, 4, SAME)])
    assert ids(call(server, "search_messages", {"limit": 1})) == [40]
    second = call(server, "search_messages", {"limit": 2, "cursor": first["next_cursor"]})
    assert ids(second) == [32, 31]
    third = call(server, "search_messages", {"limit": 2, "cursor": second["next_cursor"]})
    assert ids(third) == [41, 39] and third["has_more"] is False and third["next_cursor"] is None


def test_a_cursor_only_continues_the_search_it_came_from(tmp_path):
    mail = FakeMail()
    server = create_server(bridge=mail, state_dir=tmp_path / "state", mail_data=make_index(tmp_path / "Mail", TIED))
    query = {"from": "isabel", "sort": "newest", "account_id": WORK}
    cursor = call(server, "search_messages", {**query, "limit": 1})["next_cursor"]
    asked = len(mail.requests)
    for changed in ({"from": "Isabel"}, {"from": ""}, {"sort": "oldest"}, {"account_id": HOME},
                    {"mailbox": ["[Gmail]", "All Mail"]}):
        with pytest.raises(Exception, match="different search"):
            call(server, "search_messages", {**query, **changed, "cursor": cursor})
    forged = [base64.urlsafe_b64encode(json.dumps(data).encode()).decode() for data in (
        {"q": "x", "after": [1, WORK]}, {"q": "x", "after": [True, WORK, 1]}, {"q": "x", "after": [1, WORK, 0]}, [1])]
    for bad in ("", "not a cursor", cursor[:-6], *forged):
        with pytest.raises(Exception, match="not one search_messages returned"):
            call(server, "search_messages", {**query, "cursor": bad})
    assert len(mail.requests) == asked
    # The same search continues, with any limit.
    assert ids(call(server, "search_messages", {**query, "limit": 5, "cursor": cursor})) == [32, 31]


def test_the_scan_continues_from_an_index_cursor_and_hands_back_one_the_index_continues(tmp_path):
    class Scanning(FakeMail):
        def call(self, operation, args):
            self.requests.append((operation, args))
            return {"messages": [{"ref": {"account_id": WORK, "mailbox": ["[Gmail]", "All Mail"], "message_id": 32,
                                          "header_message_id": "header-32"}, "date_received": "2026-11-05T00:00:00.000Z"}],
                    "complete": True, "has_more": True, "sort": args["sort"]}

    indexed = create_server(bridge=FakeMail(), state_dir=tmp_path / "state", mail_data=make_index(tmp_path / "Mail", TIED))
    first = call(indexed, "search_messages", {"limit": 2})
    mail = Scanning()
    scanned = create_server(bridge=mail, state_dir=tmp_path / "state", mail_data=None)
    second = call(scanned, "search_messages", {"limit": 1, "cursor": first["next_cursor"]})
    stamp = int(datetime.fromisoformat(SAME).timestamp()) * 1000
    assert mail.requests == [("search_messages", {"from": "", "sort": "newest", "limit": 1, "account_id": None,
                                                  "mailbox": None, "after": [stamp, "__local__", 33]})]
    assert second["backend"] == "scan" and ids(second) == [32]
    assert ids(call(indexed, "search_messages", {"limit": 5, "cursor": second["next_cursor"]})) == [31, 39]
