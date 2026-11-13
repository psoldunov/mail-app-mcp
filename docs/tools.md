# Tool reference

The server exposes thirteen tools over local MCP stdio. The JSON examples are tool argument objects, not shell commands. Replace example IDs, paths, and addresses with values returned by discovery. A Mail tool call launches Mail hidden if it is closed. Existing Mail windows keep their visibility. Startup errors leave the MCP connection open.

Successful tools return JSON objects through the MCP SDK. Validation, policy, and Mail failures are reported as tool errors, not successful empty results. MCP tool annotations describe intent; they do not grant permission or prevent Mail from synchronizing.

## Shared inputs

An account ID is an opaque, nonempty string, up to 512 characters without control characters U+0000 through U+001F. `__local__` represents On My Mac. A mailbox path is an array of 1 to 20 exact name segments, each 1 to 255 characters with the same control-character restriction. A slash inside a segment is part of the name.

Copy the complete `ref` returned by `list_messages` or `search_messages` when addressing a message:

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

Draft autosave can change both `message_id` and `header_message_id`, even immediately after a listing. If a reference is missing or stale, call `list_messages` again and use the fresh `ref`. An outgoing `draft_id` is a separate identifier used only by `show_draft`; never substitute it into a message reference.

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

## search_messages

```json
{"from": "isabel", "sort": "newest", "limit": 1}
```

Searches all accounts and mailboxes visible to Mail, including On My Mac, Sent, Junk, and Trash. Mail evaluates the literal sender substring in `from`; this is not an IMAP/provider search. No bodies are fetched. An empty `from` matches all messages. Use the existing `list_messages` tool for subject/body searches.

| Argument | Default | Meaning |
| --- | --- | --- |
| `from` | `""` | Literal sender substring, up to 1,000 characters, using Mail's matching semantics. |
| `sort` | `"newest"` | `newest` or `oldest`, by received date. |
| `limit` | `50` | Maximum messages returned, from 1 to 100. |
| `account_id` | `null` | Restrict to one account, including `__local__`. |
| `mailbox` | `null` | Exact mailbox path; requires `account_id`. |

All matching IDs and received dates are considered before applying `limit`. Repeated label views of the same account and Mail ID are deduplicated. Equal timestamps are ordered by account ID and numeric Mail ID. Returned message fields and owning-mailbox references match `list_messages`.

`complete: true` means the selected scope was fully enumerated during the call; `has_more: true` means the limit omitted additional matches. Unlike `list_messages`, this tool does not return a partial scan or continuation. It fails if a mailbox fails, metadata changes are detected, or the search exceeds 1,000 mailboxes, 20,000 matching header occurrences, or a 20-second work budget. Narrow the scope or sender filter and retry. One Apple event can exceed the work budget; the bridge's 30-second timeout remains the outer limit.

Mail does not provide an atomic snapshot through scripting. New mail can arrive during a call, and results reflect Mail's currently available data, not a freshly synchronized provider snapshot. Matching and bulk-property behavior still require live acceptance on the installed Mail version.

`matched_candidates` counts header occurrences before deduplication; `mailboxes_searched` counts the selected mailboxes. `timing_ms` reports discovery, filter-and-sort, summary, and total work as `discovery`, `filter_and_sort`, `summaries`, and `total`. These timings exclude process startup and hidden application launch, so compare them with the client's total duration when profiling.

## read_message

| Argument | Default | Meaning |
| --- | --- | --- |
| `ref` | Required | Complete message reference. |
| `max_chars` | `50000` | Returned body limit, from 1 to 100,000 characters. |

Returns `ref`, `subject`, `sender`, `to`, `cc`, `body`, `truncated`, and `attachments`. Recipient fields are arrays of addresses. Each attachment has `attachment_id`, `name`, `mime_type`, `size`, and `downloaded`. The size comes from Mail's approximate metadata; attachment extraction checks actual exported bytes too. `truncated: true` means the returned body is incomplete. This limit bounds the returned text, not how much text Mail may load internally.

If Mail's attachment MIME-type getter fails with AppleEvent error `-10000`, that attachment reports `mime_type: "application/octet-stream"` and a `warning`. The message body and other metadata remain readable. Other getter errors still fail the call.

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

When Mail cannot supply MIME metadata (`-10000`), extraction returns the same warning and bounded base64, subject to the 1 MiB binary limit. It does not infer a type from the filename; PDF/text extraction requires available MIME metadata.

## create_draft

Arguments are `draft` (required) and `open_window` (boolean, default `false`). `open_window: true` requests that the saved draft be shown in Mail. The `draft` object contains these fields:

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
| `open_window` | `false` | Show the saved reply draft in Mail. |

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

Saved drafts are rejected before native reply creation, including drafts exposed through Gmail's All Mail view. Choose a received message to reply to, or use `create_draft` for a new standalone draft. This guard checks Mail's native Drafts membership rather than a localized folder name.

## show_message

One required argument: `ref`, the complete message reference. Opens that revalidated message in Mail and may bring Mail forward. It does not accept paths or URLs. Showing a message may affect its read state through Mail's normal behavior.

Returns `{"shown": true}`. Like other operations with side effects, this tool observes the shared write lock and uncertain-write block.

## show_draft

| Argument | Required | Meaning |
| --- | --- | --- |
| `account_id` | Yes | Exact account ID returned by draft creation. |
| `draft_id` | Yes | Nonnegative integer ID from 0 to 2⁵³ − 1 returned by `create_draft` or `reply_draft`. Mail can assign outgoing draft ID `0`. |
| `sender` | Yes | Exact sender returned by draft creation. |

Shows the identified outgoing draft in Mail and may bring Mail forward. The account and sender must still validate. A draft ID only refers to a currently available outgoing draft; it can become stale after a window closes or Mail restarts. Failure to find it is an ordinary tool error. Locate the draft manually in Mail instead of creating a duplicate. This tool cannot edit or send the draft, open an arbitrary file, or follow a URL.

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

Automation errors include the failed operation, bounded underlying automation message or stderr, an AppleScript error number when provided, and `retry_safe=true|false`. Read timeouts and invalid responses are safe to retry and do not claim an unknown write outcome. Retrying safely does not fix denied permissions or unavailable accounts.

The bridge gives Mail operations 30 seconds. A timeout or failed response after a write can mean Mail accepted the operation but the result was lost. A persistent `write-uncertain` marker blocks later writes until the owner reconciles Mail and clears it manually. Do not automatically retry writes. Reads remain available. See [setup and recovery](setup.md#recover-after-an-uncertain-write).

There are no send, permanent-delete, empty-Trash, arbitrary-script, rules, account-settings, quit, or runtime-policy tools. [The safety model](safety.md) describes the boundary with other agent tools and Mail itself.
