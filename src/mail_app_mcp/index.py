"""Sender search answered from Mail's own message index, the SQLite file Mail itself searches.

The index finds and orders the matches and supplies their listing fields. Mail then confirms that it
still holds each message about to be returned and supplies the header Message-ID that later calls
check refs against. Whenever the two disagree, the search is rerun as a scan through Mail.
"""

import base64
import binascii
import hashlib
import json
import logging
import os
import re
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

MAIL_DATA = Path.home() / "Library" / "Mail"
LOCAL = "__local__"
# shortcut: only these mailbox URL forms were compared with Mail's scripting paths (macOS 27, Mail 16);
# check an Exchange or POP store the same way before adding its scheme.
SCHEMES = frozenset({"imap", "local"})
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
log = logging.getLogger("mail_app_mcp")


class IndexUnavailable(Exception):
    """The index cannot answer this search; the scan through Mail still can."""


def open_index(mail_data: Path | None) -> sqlite3.Connection:
    if mail_data is None:
        raise IndexUnavailable("index search is switched off")
    try:
        versions = [name for name in os.listdir(mail_data) if name[:1] == "V" and name[1:].isdigit()]
    except OSError as exc:
        raise IndexUnavailable(f"Mail's index is not readable ({exc.strerror}); grant Full Disk Access "
                               "to the app that launches this server") from exc
    if not versions:
        raise IndexUnavailable("Mail has no message index yet")
    path = mail_data / max(versions, key=lambda name: int(name[1:])) / "MailData" / "Envelope Index"
    # Read-only, and never immutable: Mail keeps writing to this file through its write-ahead log.
    return sqlite3.connect(f"file:{quote(str(path))}?mode=ro", uri=True, timeout=1)


def sender_text(comment: str | None, address: str | None) -> str:
    """The sender as Mail's scripting writes it: a display name holding a comma is quoted.

    Mail also quotes an occasional other name, differently before and after a restart, so only those
    quotes can differ from what the scan and read_message report.
    """
    if not comment:
        return address or ""
    name = '"' + comment.replace("\\", "\\\\").replace('"', '\\"') + '"' if "," in comment else comment
    return f"{name} <{address}>"


def mailboxes(connection: sqlite3.Connection) -> dict[int, tuple[str, str, tuple[str, ...]]]:
    """Mailbox row -> (URL scheme, account ID, path), the last two as Mail's scripting reports them."""
    def parsed(url: str) -> tuple[str, str, tuple[str, ...]]:
        parts = urlsplit(url)
        path = tuple(unquote(segment) for segment in parts.path[1:].split("/"))
        covered = parts.scheme in SCHEMES and not parts.query and not parts.fragment and all(path)
        return (parts.scheme if covered else "", LOCAL if parts.scheme == "local" else parts.netloc, path)
    return {rowid: parsed(url) for rowid, url in connection.execute("SELECT ROWID, url FROM mailboxes")}


def label_rank(path: tuple[str, ...]) -> int:
    """Gmail lists one message under several labels; refs prefer INBOX, then other labels, then All Mail."""
    name = path[-1].lower()
    return 0 if name == "inbox" else 2 if name == "all mail" else 1


def account_order(account: str) -> tuple[bool, str]:
    """Equal dates order by account as the scan does: On My Mac first, then account ID."""
    return account != LOCAL, account


def utc_text(stamp: int) -> str:
    """Milliseconds since the epoch as the UTC ISO text results use for date_received."""
    return (EPOCH + timedelta(milliseconds=stamp)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def received_range(after: str | None, before: str | None) -> tuple[int | None, int | None]:
    """after (inclusive) and before (exclusive) in ms since the epoch. A value without an offset is local time."""
    def stamp(name: str, text: str | None) -> int | None:
        if text is None:
            return None
        try:
            moment = datetime.fromisoformat(text)
            micros = ((moment if moment.tzinfo else moment.astimezone()) - EPOCH) // timedelta(microseconds=1)
            # fromisoformat drops digits past the microsecond; a nonzero one puts the instant just after micros.
            finer = re.search(r"[.,]\d{6}(\d+)", text)
            micros += bool(finer and finer.group(1).strip("0"))
            # Received dates are whole milliseconds, so rounding a finer bound up keeps both ends exact.
            result = -(-micros // 1000)
            utc_text(result)
        except (ValueError, OverflowError, OSError):
            raise ValueError(f"{name} must be an ISO 8601 date or date and time, such as 2026-03-01, "
                             f"2026-03-01T09:30 or 2026-03-01T09:30:00Z; got {text!r}") from None
        return result
    low, high = stamp("after", after), stamp("before", before)
    if low is not None and high is not None and low >= high:
        raise ValueError("after must be earlier than before: after is inclusive and before exclusive, "
                         "so March is after=2026-03-01, before=2026-04-01")
    return low, high


def received_clause(args: dict) -> tuple[str, list]:
    """Whole-second bounds on date_received, so SQLite seeks its date index to the range."""
    bounds = [(">=", args["received_after"]), ("<", args["received_before"])]
    # date_received counts whole seconds: d * 1000 >= ms iff d >= ceil(ms / 1000), and the same for <.
    return ("".join(f" AND m.date_received {operator} ?" for operator, stamp in bounds if stamp is not None),
            [-(-stamp // 1000) for _, stamp in bounds if stamp is not None])


def query_digest(args: dict) -> str:
    """A cursor continues only the search it came from: the same sender text, scope, sort and date range."""
    fields = [args[key] for key in ("from", "account_id", "mailbox", "sort", "received_after", "received_before")]
    return hashlib.sha256(json.dumps(fields).encode()).hexdigest()[:16]


def resume_point(args: dict, cursor: str | None) -> list | None:
    """The (timestamp in ms, account ID, Mail ID) of the last message a previous page returned."""
    if cursor is None:
        return None
    try:
        data = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
        stamp, account, message_id = data["after"]
        valid = (type(data["q"]) is str and type(stamp) is int and abs(stamp) <= 2**53 - 1
                 and type(account) is str and 0 < len(account) <= 512
                 and type(message_id) is int and 1 <= message_id <= 2**53 - 1)
    except (binascii.Error, UnicodeDecodeError, ValueError, TypeError, KeyError):
        valid = False
    if not valid:
        raise ValueError("cursor is not one search_messages returned; start again without cursor")
    if data["q"] != query_digest(args):
        raise ValueError("cursor belongs to a different search; repeat its from, account_id, mailbox, sort, "
                         "after and before, or start again without cursor")
    return [stamp, account, message_id]


def next_cursor(args: dict, result: dict) -> str | None:
    """Continues after the last message returned, so mail arriving between pages neither repeats nor skips one."""
    if not result.get("has_more") or not result.get("messages"):
        return None
    last = result["messages"][-1]
    stamp = round(datetime.fromisoformat(last["date_received"]).timestamp() * 1000)
    after = [stamp, last["ref"]["account_id"], last["ref"]["message_id"]]
    return base64.urlsafe_b64encode(json.dumps({"q": query_digest(args), "after": after}).encode()).decode()


def after_clause(after: list | None, newest: bool, accounts: list[str]) -> tuple[str, list]:
    """Rows strictly past the cursor in ORDER BY date_received, account_rank, ROWID order."""
    if after is None:
        return "", []
    stamp, account, rowid = after
    # Ranks are positions among this search's accounts, so place the cursor's account even if it has left them.
    later = sum(account_order(other) <= account_order(account) for other in accounts)
    same = later - 1 if account in accounts else -1
    onward = "<" if newest else ">"
    # The whole-second bound lets SQLite seek its date index instead of walking every earlier page.
    # shortcut: a NULL date is never past a cursor, so later pages skip the check that sends such a store to the
    # scan; no NULL date seen on a real store yet, add "OR m.date_received IS NULL" for newest if one appears.
    return (f" AND m.date_received {onward}= ? AND (m.date_received * 1000 {onward} ?"
            f" OR (m.date_received * 1000 = ? AND (scope.account_rank >= ?"
            f" OR (scope.account_rank = ? AND m.ROWID {onward} ?))))",
            [stamp // 1000, stamp, stamp, later, same, rowid])


def nominate(connection: sqlite3.Connection, args: dict) -> dict:
    account_id, wanted = args["account_id"], args["mailbox"]
    boxes = {rowid: box for rowid, box in mailboxes(connection).items() if account_id in (None, box[1])}
    target = next((rowid for rowid, box in boxes.items() if wanted is not None and list(box[2]) == wanted), None)
    scoped = target is not None
    if not boxes or (wanted is not None and not scoped):
        # Mail decides whether the account or mailbox is missing, and words the error.
        raise IndexUnavailable("the index does not hold the requested account or mailbox")
    if not all(scheme for scheme, _, _ in boxes.values()):
        raise IndexUnavailable("the search covers a mailbox whose kind index search does not handle yet")
    accounts = sorted({box[1] for box in boxes.values()}, key=account_order)
    needle = args["from"].lower()
    connection.create_function(
        "sender_matches", 2, lambda comment, address: needle in sender_text(comment, address).lower(),
        deterministic=True)
    direction = "DESC" if args["sort"] == "newest" else "ASC"
    after, after_values = after_clause(args["after"], args["sort"] == "newest", accounts)
    received, received_values = received_clause(args)
    # shortcut: SQLite walks messages in date order, so a sender with few or no matches reads every row
    # (about 1 s per million messages), or every row in the range when after or before bounds the search;
    # count the matches first and start from the sender index if stores get there.
    # shortcut: like a cursor bound (see after_clause), a range leaves out a row with a NULL date instead of sending
    # the search to the scan.
    rows = connection.execute(
        f"WITH scope(mailbox, account_rank) AS (VALUES {','.join('(?,?)' for _ in boxes)})"
        " SELECT m.ROWID, m.mailbox, m.date_received, a.comment, a.address,"
        " COALESCE(m.subject_prefix, '') || COALESCE(s.subject, ''), m.read, m.flagged"
        " FROM messages m JOIN scope ON scope.mailbox = m.mailbox"
        " LEFT JOIN addresses a ON a.ROWID = m.sender LEFT JOIN subjects s ON s.ROWID = m.subject"
        " WHERE m.deleted = 0"
        + (" AND m.sender IN (SELECT ROWID FROM addresses WHERE sender_matches(comment, address))" if needle else "")
        + (" AND (m.mailbox = ? OR m.ROWID IN (SELECT message_id FROM labels WHERE mailbox_id = ?))" if scoped else "")
        + after + received
        + f" ORDER BY m.date_received {direction}, scope.account_rank, m.ROWID {direction} LIMIT ?",
        [value for rowid, box in boxes.items() for value in (rowid, accounts.index(box[1]))]
        + ([target, target] if scoped else []) + after_values + received_values + [args["limit"] + 1]).fetchall()
    chosen = rows[:args["limit"]]
    if not all(type(row[2]) is int for row in chosen):
        raise IndexUnavailable("the index holds a message without a received date")
    labels = [] if scoped else connection.execute(
        f"SELECT message_id, mailbox_id FROM labels WHERE message_id IN ({','.join('?' for _ in chosen)})",
        [row[0] for row in chosen]).fetchall()

    def listed_in(rowid: int, home: int) -> tuple[str, ...]:
        if scoped:
            return boxes[target][2]  # A search of one mailbox keeps the mailbox that was asked for.
        places = [home] + [box for message, box in labels if message == rowid and box in boxes]
        return boxes[min(places, key=lambda box: (label_rank(boxes[box][2]), box))][2]

    return {"has_more": len(rows) > args["limit"], "mailboxes_searched": 1 if scoped else len(boxes), "messages": [{
        "ref": {"account_id": boxes[home][1], "mailbox": list(listed_in(rowid, home)), "message_id": rowid},
        "subject": subject, "sender": sender_text(comment, address),
        "date_received": datetime.fromtimestamp(received, timezone.utc)
        .isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "read": bool(read), "flagged": bool(flagged), "timestamp": received * 1000,
    } for rowid, home, received, comment, address, subject, read, flagged in chosen]}


def confirmed(bridge, messages: list[dict]) -> list[dict]:
    """Mail must still hold every nominated message; its header Message-ID completes each ref."""
    if not messages:
        return []
    headers = bridge.call("confirm_messages", {"messages": [
        {**{key: item["ref"][key] for key in ("account_id", "mailbox", "message_id")}, "timestamp": item["timestamp"]}
        for item in messages]}).get("header_message_ids")
    if (not isinstance(headers, list) or len(headers) != len(messages)
            or not all(isinstance(header, str) for header in headers)):
        raise IndexUnavailable("Mail did not confirm a message the index named")
    return [{**{key: value for key, value in item.items() if key != "timestamp"},
             "ref": {**item["ref"], "header_message_id": header}} for item, header in zip(messages, headers)]


def search(bridge, mail_data: Path | None, args: dict, cursor: str | None = None) -> dict:
    """Answer from the index when it can be read and Mail agrees; otherwise scan through Mail as before.

    Both continue after the cursor's message by the same order, so either can serve any page.
    """
    args = {**args, "after": resume_point(args, cursor)}
    # The range as it was read, so a caller sees which instants a local date meant.
    echo = {name: None if args[key] is None else utc_text(args[key])
            for name, key in (("after", "received_after"), ("before", "received_before"))}
    started = time.monotonic()
    try:
        try:
            with closing(open_index(mail_data)) as connection:
                found = nominate(connection, args)
        except sqlite3.Error as exc:
            raise IndexUnavailable(f"Mail's index could not be queried ({exc})") from exc
        indexed = time.monotonic()
        messages = confirmed(bridge, found["messages"])
    except IndexUnavailable as exc:
        log.info("search_messages scans through Mail: %s", exc)
        scanned = bridge.call("search_messages", args)
        return {**scanned, **echo, "next_cursor": next_cursor(args, scanned), "backend": "scan",
                "index_unavailable": str(exc)}
    done = time.monotonic()
    page = {"messages": messages, "has_more": found["has_more"]}
    return {**page, **echo, "next_cursor": next_cursor(args, page), "complete": True, "sort": args["sort"],
            "mailboxes_searched": found["mailboxes_searched"], "backend": "index",
            "timing_ms": {"index": round((indexed - started) * 1000), "confirm": round((done - indexed) * 1000),
                          "total": round((done - started) * 1000)}}
