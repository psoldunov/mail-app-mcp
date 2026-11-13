# Tool reference

The server exposes twelve tools over local MCP stdio. The JSON examples are tool argument objects, not shell commands. Replace example IDs, paths, and addresses with values returned by discovery. A Mail tool call launches Mail hidden if it is closed. Existing Mail windows keep their visibility. Startup errors leave the MCP connection open.

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

A reference can name any mailbox that lists the message. For Gmail, a message listed in `INBOX` is stored in `["[Gmail]", "All Mail"]`, and either path works.

Draft autosave can change both `message_id` and `header_message_id`, even immediately after a listing. If a reference is missing or stale, call `list_messages` again and use the fresh `ref`.

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

Returns `messages`, `next_offset`, `complete`, `scanned`, and `stopped`. Each message contains `ref`, `subject`, `sender`, `date_received` (ISO timestamp), `read`, and `flagged`. `ref.mailbox` is the mailbox you listed, so a Gmail `INBOX` listing returns `INBOX` references. Results contain no body preview; use `read_message` for the body of a selected message.

`stopped` says why the page ended: `limit` (enough matches), `time_budget` (body search ran out of time), or `end` (no messages left). Until `complete` is true and `next_offset` is null, continue with `next_offset` and the same account, mailbox, and query. There is no regex, provider search syntax, or arbitrary predicate. Ordering follows Mail; offset pagination is best effort while Mail changes and may skip or repeat entries.

Each call reads the subject, sender, date, flags, and IDs of every message in the mailbox, one Apple event per property. Mail answers those in about 0.3 seconds per property for 5,000 messages, while reading the same fields one message at a time takes over a second per message. Subject and sender matching then runs locally, so a header query covers the whole mailbox in one call. If the IDs change while the call reads them, it fails with `Mailbox changed while listing`.

Body search still loads one body at a time. It stops starting new body checks after a 10-second budget, which begins after the header read, so each call checks at least one message and `next_offset` always advances. The bridge's 60-second timeout remains the outer limit.

Before loading a body for `search_body: true`, the bridge requires Mail's reported message size to be known, positive, and no more than 20 MiB. Encountering an oversized or unknown-size message that needs body searching fails that call. Use `search_body: false` to search only subject/sender without loading bodies.

## search_messages

```json
{"from": "isabel", "sort": "newest", "limit": 1}
```

Searches all accounts and mailboxes visible to Mail, including On My Mac, Sent, Junk, and Trash. The server reads every mailbox's sender, ID, and date fields from Mail in bulk and matches `from` as a case-insensitive literal substring of the sender; this is not an IMAP/provider search. No bodies are fetched. An empty `from` matches all messages. Use the existing `list_messages` tool for subject/body searches.

| Argument | Default | Meaning |
| --- | --- | --- |
| `from` | `""` | Case-insensitive literal sender substring, up to 1,000 characters. |
| `sort` | `"newest"` | `newest` or `oldest`, by received date. |
| `limit` | `50` | Maximum messages returned, from 1 to 100. |
| `account_id` | `null` | Restrict to one account, including `__local__`. |
| `mailbox` | `null` | Exact mailbox path; requires `account_id`. |

All matching IDs and received dates are considered before applying `limit`. Repeated label views of the same account and Mail ID are deduplicated. Equal timestamps are ordered by account ID, then by Mail ID: highest first for `newest`, lowest first for `oldest`. Returned message fields match `list_messages`. When Gmail lists one message under several labels, `ref.mailbox` is `INBOX` if that is one of them, then any other label, and All Mail last. A mailbox that Mail counts as empty but refuses to read in bulk, such as Gmail's Notes, is treated as empty.

`complete: true` means the selected scope was fully enumerated during the call; `has_more: true` means the limit omitted additional matches. Unlike `list_messages`, this tool does not return a partial scan or continuation. It fails if a mailbox fails, metadata changes are detected, or the search exceeds 1,000 mailboxes, 20,000 matching header occurrences, or a 35-second work budget. The first search after Mail starts is the slowest: on one machine an unscoped search over 40 mailboxes took 20 seconds cold and 4 seconds warm. Narrow the scope or sender filter and retry. On a store with several large accounts, an unscoped search can exceed the budget even with a sender filter; pass `account_id`, and `mailbox` if needed. One Apple event can exceed the work budget; the bridge's 60-second timeout remains the outer limit.

Mail does not provide an atomic snapshot through scripting. New mail can arrive during a call, and results reflect Mail's currently available data, not a freshly synchronized provider snapshot. Matching and bulk-property behavior still require live acceptance on the installed Mail version.

`matched_candidates` counts header occurrences before deduplication; `mailboxes_searched` counts the selected mailboxes. `timing_ms` reports discovery, filter-and-sort, summary, and total work as `discovery`, `filter_and_sort`, `summaries`, and `total`. These timings exclude process startup and hidden application launch, so compare them with the client's total duration when profiling.

## read_message

| Argument | Default | Meaning |
| --- | --- | --- |
| `ref` | Required | Complete message reference. |
| `max_chars` | `50000` | Returned body limit, from 1 to 100,000 characters. |

Returns `ref`, `subject`, `sender`, `to`, `cc`, `bcc`, `body`, `truncated`, `links`, `links_truncated`, and `attachments`. Recipient fields are arrays of addresses. Mail leaves the account's own addresses out of its recipient lists, so the server also reads the `To`, `Cc`, and `Bcc` headers and merges them in; `bcc` is usually empty except on drafts. Each attachment has `attachment_id`, `name`, `mime_type`, `size`, and `downloaded`. The size comes from Mail's approximate metadata; attachment extraction checks actual exported bytes too. `truncated: true` means the returned body is incomplete. This limit bounds the returned text, not how much text Mail may load internally.

`links` is an array of `{"url": "https://example.org/invoice", "text": "View invoice"}` objects extracted from the message's HTML body. Only `http`, `https`, and `mailto` links are included; the server never fetches or opens them. Extraction considers at most 100,000 characters of MIME source. For oversized source, extraction keeps complete links from that prefix and sets `links_truncated: true`; a link cut off at the boundary is omitted. If source is missing or its getter reports Mail error `-10000`, the plain-text read remains available with `links: []` and `links_truncated: true`. Other source-getter errors fail the call. The boolean also marks incomplete extraction when link limits are reached. A message without HTML links can return `links: []` with `links_truncated: false`. Raw MIME source is never returned. The source limit is separate from `max_chars` and does not bound how much Mail loads internally.

Mail's attachment MIME-type getter can fail with AppleEvent error `-10000`. The server then guesses the type from the file name and adds a `warning`; when the name gives no type, it reports `application/octet-stream`. The name is untrusted, so a guessed type only decides whether `read_attachment` extracts text. The message body and other metadata remain readable. Other getter errors still fail the call.

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
| `application/pdf` | `text`, `truncated`, `pages` (total document pages). Extracts at most the first 50 pages and 100,000 characters. Unmapped NUL characters in the returned text become U+FFFD (`�`), with a `warning` giving their count. Readable text remains available; verify affected amounts or punctuation against the original PDF. Encrypted, malformed, or resource-exhausting files fail. Image-only PDFs may produce empty text; no OCR. |
| Other MIME types | `base64`, `encoding: "base64"`. The binary file must be at most 1 MiB. Images also use base64; there is no image rendering or recognition. |

Every export must already be downloaded in Mail and fit the 10 MiB attachment limit. PDF parsing runs in a subprocess with a 10-second parent-enforced timeout and a 5-second CPU limit. A macOS watchdog samples peak resident memory every 20 milliseconds and terminates the worker above 512 MiB; allocation can overshoot between samples. This is not a hard memory cap or a security sandbox. Resource limits can reject a valid but expensive PDF. There is no password input.

The server chooses a private temporary path and removes the export after processing. It accepts no path, URL, or upload, and returns no filesystem path or reusable handle. Attachment content, filenames, and MIME metadata remain untrusted.

When Mail cannot supply MIME metadata (`-10000`), extraction uses the type guessed from the file name, as `read_message` reports it, and returns the same warning. If PDF extraction also produces a warning, `warning` contains both. A `.pdf` or `.txt` name therefore gets PDF or text extraction; a name with no known type gets bounded base64, subject to the 1 MiB binary limit. PDF worker errors retain the worker's reason in the tool error.

## create_draft

Arguments are `draft` (required) and `open_window` (boolean, default `false`). `open_window: true` opens the saved draft in a Mail window and brings Mail forward. The `draft` object contains these fields:

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

Returns `status: "draft"`, `account_id`, `sender`, and `ref`, the reference of the copy Mail saved in Drafts. Pass that `ref` to `read_message` to check the draft or to `show_message` to open it. The sender must belong to exactly one account; an address advertised by multiple accounts is rejected as ambiguous. It saves a new draft and never sends. Mail may sync the draft to its provider, and it can still replace the saved copy later; if the `ref` goes stale, list the Drafts mailbox again. This server cannot edit a draft. A repeated creation call creates another draft; do not retry an uncertain call automatically.

The server clears Mail's automatic signature for new drafts; include any signature you want in `body`. It composes every draft in a hidden window, saves it, then waits for the saved copy to appear in Drafts with the requested subject and body. It then saves the draft a second time, at least 3 seconds after the first, and returns the newest copy once it has stayed the same for 5 one-second checks. The whole wait stops at 30 seconds. The second save accounts for Mail replacing saved drafts under new IDs during autosave. If no copy appears in time, the call still succeeds, with `ref: null` and a `warning`; it opens no window, and you should find the draft in Drafts instead of retrying. If a copy appears but never contains the body, the call fails as an uncertain write. If Mail cannot open the saved copy for `open_window`, the call succeeds with the `ref` and a `warning`; open it with `show_message`.

Mail keeps every hidden compose window until it quits, and scripting cannot close one. Their drafts are already saved, but Mail can autosave a hidden window into Drafts on its own, so quit Mail now and then to clear them. A compose window that opens visible does close by script and keeps its saved draft, but the server does not compose in one. In testing, reading the body of a visible reply through scripting froze Mail until it was force quit, and a visible reply accepted a scripted body 0.1 seconds after it opened but ignored one set 0.5 seconds or later.

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

Returns the same draft result fields as `create_draft`. Mail supplies the native recipients, subject, and threading headers. The server clears Mail's automatic signature before setting the reply text. The draft contains your body followed by a plain-text quote of the original (`On <date>, <sender> wrote:` followed by `> ` lines, cut at 100,000 characters). Include any signature you want in `body`. Inspect the draft in Mail before sending it yourself. There is no cross-account reply sender or recipient override, and no existing-draft editing.

The server builds the quote itself because of two Mail behaviors. Mail opens a reply window even when asked not to, and a visible reply window autosaves its own quoted text over a scripted body. The server hides the window before setting the body, and a hidden reply keeps the body but drops Mail's quote. Mail first saves a copy with its own quote and replaces it with the body copy 5 to 15 seconds later, so a reply can take that long to return.

The source message must have a known, positive Mail-reported size no greater than 20 MiB before its content is loaded for the quote.

Saved drafts are rejected before native reply creation, including drafts exposed through Gmail's All Mail view. Choose a received message to reply to, or use `create_draft` for a new standalone draft. This guard checks Mail's native Drafts membership rather than a localized folder name.

## show_message

One required argument: `ref`, the complete message reference. Opens that revalidated message in Mail and may bring Mail forward. To show a saved draft, pass the `ref` that `create_draft` or `reply_draft` returned. It does not accept paths or URLs. Showing a message may affect its read state through Mail's normal behavior.

Returns `{"shown": true}`. It waits for the shared write lock, but it neither sets nor honors the uncertain-write marker: opening a window cannot duplicate mail, so it keeps working while writes are blocked, and its failures are safe to retry.

## set_message_status

| Argument | Default | Meaning |
| --- | --- | --- |
| `ref` | Required | Complete message reference. |
| `read` | `null` | `true` marks read; `false` marks unread; null leaves it unchanged. |
| `flagged` | `null` | `true` flags; `false` removes the flag; null leaves it unchanged. |

At least one of `read` or `flagged` must be supplied as a boolean. Returns `ref`, `read`, and `flagged` after the requested state settles. Verification re-resolves the message every half second and requires three consecutive matching observations, with at most ten polls. If the state does not settle, the call reports an uncertain write and blocks later writes until recovery. This tool changes no other message properties and requires no move policy; Mail or another application can still change the state afterward.

## move_message

| Argument | Required | Meaning |
| --- | --- | --- |
| `ref` | Yes | Complete source message reference. |
| `destination` | Yes | Exact mailbox path, subject to that account's destination restrictions. |

The destination must already exist in the same account. Without an account policy, or with omitted or `null` `allowed_destinations`, ordinary same-account destinations are permitted. An explicit list, including `[]`, permits only its entries plus an explicit `trash_mailbox` override. There is no destination-account argument, folder creation, or cross-account move. Moving to the current mailbox is rejected. Sending destinations and resolved Drafts/Sent destinations are rejected even when configured.

A move requires a nonempty Message-ID unique in the source and absent from the destination. Overlapping labels, including Gmail INBOX to All Mail, are rejected before writing; archive these messages manually in Mail. The server never substitutes delete for archive. After one assignment to Mail's writable message `mailbox` property, fresh mailbox queries must show that the message left the source and exists uniquely in the destination. Verification waits up to ten half-second polls; Apple-event latency adds to that time. Mail error `-1728` after assignment is accepted only if these queries prove the transfer. A failed verification leaves the outcome uncertain.

The native `move` command timed out and misfiled a Gmail label move in field testing. Mailbox assignment restores the earlier write method while retaining fresh verification. Its behavior on Gmail labels still needs supervised acceptance testing; a timeout may complete later. Inspect both mailboxes before clearing an uncertain-write marker, and do not retry automatically.

Returns `account_id`, `destination`, and `moved: true` only after verification. It does not return a new reference: list the destination mailbox again before another operation because Mail IDs can change after a move.

## trash_message

One required argument: `ref`, the complete message reference.

Moves the message to that account's explicit `trash_mailbox` override, or discovers Mail's actual account Trash when the setting is omitted or `null`. Discovery fails if the result is missing or ambiguous; folder names are never guessed. A discovered path must pass `allowed_destinations`, so an explicit restricted list must contain it. An explicit Trash override authorizes its path independently of that list. Sending and Drafts/Sent destination guards still apply. Already being in the selected Trash is an error. Returns the same fields as `move_message`. No delete command runs, but Mail or provider retention can permanently purge messages afterward.

## Errors and recovery

Automation errors include the failed operation, bounded underlying automation message or stderr, an AppleScript error number when provided, and `retry_safe=true|false`. `retry_safe` is false only for an uncertain write. Reads, `show_message`, and writes that Mail rejected before changing anything (a stale reference, a saved-draft source, a missing draft) all report `retry_safe=true`. Retrying safely does not fix denied permissions or unavailable accounts.

Mail launches asynchronously, hidden and without activation. Before scripting, the server checks launch completion and requires the process to be at least 15 seconds old. An early call reports “Mail is starting” with no write attempted; wait 15 seconds before retrying. This settling window is not a guarantee that Mail has finished synchronizing.

The bridge gives Mail operations 60 seconds. A timeout or failed response after a write can mean Mail accepted the operation but the result was lost. The server then leaves a `write-uncertain` marker that blocks later writes until the owner reconciles Mail and clears it. The marker records the operation, its target (message reference, or account and subject for a new draft), start time, process ID, and server build, and every refused write quotes it. Do not automatically retry writes. Reads remain available. See [setup and recovery](setup.md#recover-after-an-uncertain-write).

There are no send, permanent-delete, empty-Trash, arbitrary-script, rules, account-settings, quit, or runtime-policy tools. [The safety model](safety.md) describes the boundary with other agent tools and Mail itself.
