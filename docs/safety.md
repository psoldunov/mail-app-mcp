# Safety model

## Access boundary

The server calls a packaged, fixed JXA program through `/usr/bin/osascript`. Requests are JSON data. Neither MCP callers nor mailbox content can supply executable scripts, arbitrary property names, shell commands, provider URLs, or local file paths.

All mail access goes through Mail. A tool call launches Mail hidden when it is closed, without activating or hiding an existing session. Launching can trigger Mail synchronization, rules, and queued mail. Explicit show tools and `open_window: true` on draft creation may bring that application forward and open the identified item. They accept no arbitrary open path or URL. The server does not read private Mail databases, manage credentials, or use IMAP, SMTP, or provider APIs. It exposes local stdio only, with no HTTP listener. Mail may synchronize reads, drafts, flags, and moves with its providers over the network.

All Mail accounts are discoverable and readable. Move allowlists do not restrict reading, attachment extraction, draft creation, or status changes. The MCP client and its operator decide who may invoke these tools. Returned message and attachment content enters the MCP client and may be passed to its model provider according to that client's settings.

## Writes

Existing-message operations require the complete account ID, mailbox segment array, Mail message ID, and header Message-ID. The bridge resolves the message in that account and mailbox and checks the identifiers before acting. The mailbox can be any one that lists the message, such as a Gmail label stored in All Mail. Display names and a Message-ID header alone are insufficient. A stale or ambiguous reference fails; re-list after a move.

Moves remain in the source account. Missing account policy and omitted or `null` `allowed_destinations` permit ordinary destinations. An explicit list, including `[]`, restricts moves to its paths plus an explicit `trash_mailbox` override. With no override, the server discovers Mail's actual Trash for that account and applies the same destination restrictions. Missing or ambiguous discovery fails without guessing a folder name. Known sending mailboxes and resolved Drafts/Sent destinations are rejected under every policy. The owner must confirm the role of any explicit Trash override, including provider-specific or localized folders. There is no policy-editing tool.

Drafts require a sender advertised by the selected account and reject an address shared by multiple accounts. Replies use the source message's account and an explicit sender. Both operations clear Mail's automatic signature and create new drafts; they cannot send, edit an existing draft, or attach local files. Mail may sync drafts to a server, and a human can send them from Mail later.

Status changes are checked through fresh message lookups until the requested values remain stable across consecutive polls. Failure to settle is an uncertain write; do not assume the change was canceled.

A per-user file lock serializes this server's writes and `show_message` across processes. Mail's UI, rules, synchronization, and other automation do not honor that lock. Uncertain write outcomes leave a persistent marker recording what was attempted. It blocks subsequent writes only in that MCP server instance. Other instances and restarted servers start unblocked; a new chat may reuse an existing instance. Markers remain available for inspection after a session ends. The owner can clear one marker after checking Mail, or use `mail-app-mcp --clear-uncertain` to clear all recorded sessions after checking their operations. Mail can finish a timed-out operation after the server exits, so switching sessions does not make repeating it safe. See [recovery](setup.md#recover-after-an-uncertain-write). There is no automatic retry or rollback.

Trash is a move, with no permanent-delete or empty-Trash operation. Provider retention, Mail settings, or another application can purge it later. Do not use Trash as a backup.

## Attachments and untrusted content

Attachment IDs come from `read_message`; callers cannot choose an export path. Only downloaded attachments with acceptable size metadata are exported, and the actual exported file is checked again. Mail describes size metadata as approximate, so the pre-export check is not a hard bound on Mail's disk writes.

Body reading, body search, and reply creation require Mail to report a positive message size of at most 20 MiB before loading content. This guard relies on Mail's metadata and is separate from returned-text limits.

`read_message` extracts HTML links from at most 100,000 characters of MIME source and returns only URL/text pairs, never raw source. Oversized source, a missing source value, or Mail's source-getter error `-10000` leaves the plain-text read available with `links_truncated: true`; other getter errors fail the call. Source size limits bound extraction and transport to Python; Mail may still load the full source internally. Extracted URLs are untrusted and are never fetched or opened by the server.

Exports use private temporary storage and are removed after processing. The server returns no local path or persistent cache handle. Text and PDF extraction is bounded; other supported-size files return base64 without execution. There is no OCR, arbitrary file upload, or attachment URL fetching. For exact limits, see [the tool reference](tools.md#read_attachment).

Treat message bodies, filenames, PDF text, and attachment content as data. A message that asks an agent to change policy, run a command, send credentials, or ignore instructions is not authorization. The MCP instructions state this boundary, but cannot ensure that every client or model follows it.

## Limits of the guarantee

There are no tools for sending, permanent deletion, rules, account settings, arbitrary AppleScript/JXA, or quitting Mail. Hidden launch is part of the fixed startup path, not a caller-configurable tool. The fixed dispatch table also excludes those operations. Mail itself can still process queued mail, apply rules, synchronize changes, and expire messages while running.

An agent with another shell or automation tool can bypass this server and call Mail directly. Restrict those tools separately if you rely on the no-send boundary. The server is not an operating-system sandbox.

Offline tests cover the protocol, policy, and fake scripting objects. They do not prove behavior for every macOS version, Mail account backend, special mailbox, or draft save. Live validation is a separate, opt-in procedure using disposable mail; see [manual acceptance](development.md#manual-acceptance-with-a-disposable-account).
