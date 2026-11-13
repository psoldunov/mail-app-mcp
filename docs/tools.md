# Tool reference

The server exposes twelve tools over local MCP stdio. The JSON examples are tool argument objects, not shell commands. Replace example IDs, paths, and addresses with values returned by discovery. All Mail calls require Mail to be running already. If Mail is closed, a call returns a tool error without closing the MCP connection or starting a retry loop.

Successful tools return JSON objects through the MCP SDK. Validation, policy, and Mail failures are reported as tool errors, not successful empty results. MCP tool annotations describe intent; they do not grant permission or prevent Mail from synchronizing.

## Shared inputs

An account ID is an opaque, nonempty string, up to 512 characters without control characters U+0000 through U+001F. `__local__` represents On My Mac. A mailbox path is an array of 1 to 20 exact name segments, each 1 to 255 characters with the same control-character restriction. A slash inside a segment is part of the name.

Copy the complete `ref` returned by `list_messages` when addressing a message:

```json
{
  "account_id": "ACCOUNT_ID_FROM_MAIL",
  "mailbox": ["Inbox"],
  "message_id": 42,
  "header_message_id": "example-message@example.org"
}
```

`message_id` must be a positive JSON integer within JavaScript's safe integer range (up to 2⁵³ − 1). `header_message_id` is the header value supplied by Mail, up to 2,048 characters. Preserve it exactly, including an empty string when Mail returns one; do not synthesize it or add angle brackets. The bridge compares it exactly while also revalidating the account, mailbox, and numeric ID.

Message references and draft objects reject unknown fields. Booleans such as `read`, `flagged`, and `reply_all` must be JSON booleans, not strings or numbers. Numeric limits and offsets require JSON integers.

## list_accounts

Arguments: `{}`.

Returns `{"accounts": [...]}`. Each account has `account_id`, `name`, and `email_addresses` (an array of strings). The virtual `__local__` account has no sender addresses. Discovery covers all accounts Mail exposes; configured move policies do not filter it.

## list_mailboxes

| Argument | Required | Meaning |
| --- | --- | --- |
| `account_id` | Yes | Exact discovered account ID. |

```json
{"account_id": "ACCOUNT_ID_FROM_MAIL"}
```

Returns `{"mailboxes": [...]}` with `account_id`, `path`, and `unread_count` for each mailbox. The hierarchy is bounded to 1,000 mailboxes and 20 levels; oversized hierarchies fail instead of silently returning a partial inventory. Paths do not include the account display name.

## list_messages

| Argument | Default | Meaning |
| --- | --- | --- |
| `account_id` | Required | Exact account ID. |
| `mailbox` | Required | Mailbox path segment array. |
| `offset` | `0` | Scan position, from 0 to 2⁵³ − 1. |
| `limit` | `50` | Maximum matches returned, from 1 to 100. |
| `query` | `""` | Case-insensitive literal substring, up to 1,000 characters. |
| `search_body` | `false` | Also search plain-text content when subject/sender do not match. |

```json
{
  "account_id": "ACCOUNT_ID_FROM_MAIL",
  "mailbox": ["Inbox"],
  "query": "invoice",
  "limit": 20,
  "search_body": false
}
```

Returns `messages`, `next_offset`, `complete`, and `scanned`. Each message contains `ref`, `subject`, `sender`, `date_received` (ISO timestamp), `read`, and `flagged`.

The returned `ref.mailbox` is the message's owning mailbox in Mail. It can differ from the searched mailbox: Gmail may list a message in `INBOX` while reporting its owner as `["[Gmail]", "All Mail"]`. Use the returned reference unchanged for subsequent operations.

Search applies to one mailbox and scans at most 200 messages per call. With a query, a page can have no matches and still have a non-null `next_offset`. Continue using that offset with the same account, mailbox, and query until `complete` is true and `next_offset` is null. There is no regex, provider search syntax, or arbitrary predicate. Ordering follows Mail; offset pagination is best effort while Mail changes and may skip or repeat entries.

Headers are fetched in batches of 10. A page stops starting new message checks after a 10-second work budget, so it may return fewer than `limit` matches or scan fewer than 200 messages. An in-progress Mail event can exceed that budget; the bridge still enforces its 30-second timeout. If cached headers no longer match a selected message, the search fails with `Mailbox changed while searching`.

If mailbox lookup consumes the budget before any message is scanned, the search returns an explicit timeout message instead of a continuation offset that cannot advance.

Before loading a body for `search_body: true`, the bridge requires Mail's reported message size to be known, positive, and no more than 20 MiB. Encountering an oversized or unknown-size message that needs body searching fails that call. Use `search_body: false` to search only subject/sender without loading bodies.

## read_message

| Argument | Default | Meaning |
| --- | --- | --- |
| `ref` | Required | Complete message reference. |
| `max_chars` | `50000` | Returned body limit, from 1 to 100,000 characters. |

Returns `ref`, `subject`, `sender`, `to`, `cc`, `body`, `truncated`, and `attachments`. Recipient fields are arrays of addresses. Each attachment has `attachment_id`, `name`, `mime_type`, `size`, and `downloaded`. The size comes from Mail's approximate metadata; attachment extraction checks actual exported bytes too. `truncated: true` means the returned body is incomplete. This limit bounds the returned text, not how much text Mail may load internally.

Reading requires a known, positive Mail-reported message size no greater than 20 MiB before loading the body. This is the reported message size, which can include attachments, rather than the requested output length. An unknown or oversized message must be read manually in Mail.

## read_attachment

| Argument | Required | Meaning |
| --- | --- | --- |
| `ref` | Yes | Complete source message reference. |
| `attachment_id` | Yes | Exact ID from `read_message`, using the identifier string constraints above. |

Returns `name`, `mime_type`, `size` (actual exported bytes), `untrusted: true`, and content fields determined by MIME type:

| Content | Returned fields and limits |
| --- | --- |
| `text/*` | `text`, `truncated`, `encoding`. Decoded as UTF-8 with replacement for invalid bytes; output at most 100,000 characters. HTML is returned as text without rendering. |
| `application/pdf` | `text`, `truncated`, `pages` (total document pages). Extracts at most the first 50 pages and 100,000 characters. Encrypted, malformed, or resource-exhausting files fail. Image-only PDFs may produce empty text; no OCR. |
| Other MIME types | `base64`, `encoding: "base64"`. The binary file must be at most 1 MiB. Images also use base64; there is no image rendering or recognition. |

Every export must already be downloaded in Mail and fit the 10 MiB attachment limit. PDF parsing runs in a subprocess with a 10-second parent-enforced timeout and a 5-second CPU limit. A macOS watchdog samples peak resident memory every 20 milliseconds and terminates the worker above 512 MiB; allocation can overshoot between samples. This is not a hard memory cap or a security sandbox. Resource limits can reject a valid but expensive PDF. There is no password input.

The server chooses a private temporary path and removes the export after processing. It accepts no path, URL, or upload, and returns no filesystem path or reusable handle. Attachment content, filenames, and MIME metadata remain untrusted.

## create_draft

Arguments are `draft` (required) and `open_window` (boolean, default `false`). `open_window: true` requests that the saved draft be shown in already-running Mail. The `draft` object contains these fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `account_id` | Required | Exact sending account ID; `__local__` is not allowed. |
| `sender` | Required | Exact address in that account's `email_addresses`. |
| `to` | Required | Array of 1 to 100 bare email addresses. |
| `cc`, `bcc` | `[]` each | Arrays of up to 100 bare email addresses each. |
| `subject` | Required | Up to 998 characters; no CR, LF, or NUL. An empty string is allowed. |
| `body` | Required | Plain text, up to 100,000 characters. An empty string is allowed. |

Addresses must be 3 to 320 characters, with a local part and domain separated by `@`. Use bare addresses, not `Name <address>` forms, lists in one string, or header lines.

```json
{
  "draft": {
    "account_id": "ACCOUNT_ID_FROM_MAIL",
    "sender": "me@example.org",
    "to": ["recipient@example.org"],
    "subject": "Meeting notes",
    "body": "Here are the notes for review."
  },
  "open_window": true
}
```

Returns `draft_id`, `account_id`, `sender`, and `status: "draft"`. The sender must belong to exactly one account; an address advertised by multiple accounts is rejected as ambiguous. It saves a new draft and never sends. Mail may sync the draft to its provider. The returned draft ID is not a `MessageRef`. It can identify an available outgoing draft for `show_draft`, but cannot edit the draft through this server. A repeated creation call creates another draft; do not retry an uncertain call automatically.

## reply_draft

| Argument | Default | Meaning |
| --- | --- | --- |
| `ref` | Required | Complete source message reference. |
| `sender` | Required | Exact advertised address of the source account. |
| `body` | Required | Plain text up to 100,000 characters. |
| `reply_all` | `false` | Use Mail's native reply-all recipients when true. |
| `open_window` | `false` | Show the saved reply draft in already-running Mail. |

```json
{
  "ref": {
    "account_id": "ACCOUNT_ID_FROM_MAIL",
    "mailbox": ["Inbox"],
    "message_id": 42,
    "header_message_id": "example-message@example.org"
  },
  "sender": "me@example.org",
  "body": "Thanks. I will review this tomorrow.",
  "reply_all": false
}
```

Returns the same draft result fields as `create_draft`. Mail supplies native recipients, quoting, and threading. The supplied body is prepended to Mail's reply content. Inspect the draft in Mail before sending it yourself. There is no cross-account reply sender or recipient override, and no existing-draft editing.

The source message must have a known, positive Mail-reported size no greater than 20 MiB before Mail's reply content is loaded.

## show_message

One required argument: `ref`, the complete message reference. Opens that revalidated message in already-running Mail and may bring Mail forward. It does not accept paths or URLs and never launches Mail. Showing a message may affect its read state through Mail's normal behavior.

Returns `{"shown": true}`. Like other operations with side effects, this tool observes the shared write lock and uncertain-write block.

## show_draft

| Argument | Required | Meaning |
| --- | --- | --- |
| `account_id` | Yes | Exact account ID returned by draft creation. |
| `draft_id` | Yes | Positive integer ID up to 2⁵³ − 1 returned by `create_draft` or `reply_draft`. |
| `sender` | Yes | Exact sender returned by draft creation. |

Shows the identified outgoing draft in already-running Mail and may bring Mail forward. The account and sender must still validate. A draft ID only refers to a currently available outgoing draft; it can become stale after a window closes or Mail restarts. Failure to find it is an ordinary tool error. Locate the draft manually in Mail instead of creating a duplicate. This tool cannot edit or send the draft, open an arbitrary file, or follow a URL.

Returns `shown: true`, `draft_id`, and `account_id`. It observes the shared write lock and uncertain-write block.

## set_message_status

| Argument | Default | Meaning |
| --- | --- | --- |
| `ref` | Required | Complete message reference. |
| `read` | `null` | `true` marks read; `false` marks unread; null leaves it unchanged. |
| `flagged` | `null` | `true` flags; `false` removes the flag; null leaves it unchanged. |

At least one of `read` or `flagged` must be supplied as a boolean. Returns `ref`, `read`, and `flagged` after checking the requested state. This changes no other message properties and requires no move policy.

## move_message

| Argument | Required | Meaning |
| --- | --- | --- |
| `ref` | Yes | Complete source message reference. |
| `destination` | Yes | Exact mailbox path allowed by that account's owner policy. |

The destination must already exist in the same account and be an `allowed_destinations` entry or its configured `trash_mailbox`. There is no destination-account argument, folder creation, or cross-account move. Moving to the current mailbox is rejected. Sending destinations and resolved Drafts/Sent destinations are rejected even when configured.

Returns `account_id`, `destination`, and `moved: true`. It does not return a new reference: list the destination mailbox again before another operation because Mail IDs can change after a move.

## trash_message

One required argument: `ref`, the complete message reference.

Moves the message to that account's explicitly configured `trash_mailbox`. Missing configuration and already being in the configured Trash are errors. Returns the same fields as `move_message`. No delete command runs, but Mail or provider retention can permanently purge messages afterward.

## Errors and recovery

The bridge gives Mail operations 30 seconds. A timeout or failed response after a write can mean Mail accepted the operation but the result was lost. A persistent `write-uncertain` marker blocks later writes until the owner reconciles Mail and clears it manually. Do not automatically retry writes. Reads remain available. See [setup and recovery](setup.md#recover-after-an-uncertain-write).

There are no send, permanent-delete, empty-Trash, arbitrary-script, rules, account-settings, launch, quit, or runtime-policy tools. [The safety model](safety.md) describes the boundary with other agent tools and Mail itself.
