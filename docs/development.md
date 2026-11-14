# Contributing and validation

## Offline development

Use Python 3.11+, Node.js for the bridge tests, and Nix with flakes for packaging checks. Production dependencies are the official MCP Python SDK (`mcp>=1.20,<2`), Pydantic 2, and pypdf. FastMCP comes from the MCP SDK; there is no separate `fastmcp` package dependency. JavaScript tests use Node's built-in test runner without npm dependencies.

1. Install the project and test dependencies from a checkout:

   ```sh
   python3 -m venv .venv
   .venv/bin/python -m pip install -e '.[test]'
   ```

2. Run Python checks with coverage:

   ```sh
   .venv/bin/python -m pytest --cov=mail_app_mcp --cov-report=term-missing --cov-fail-under=80
   ```

3. Run the JXA dispatch tests against fake Mail objects:

   ```sh
   node --test tests/test_mail_script.js
   ```

4. On macOS, compile the JXA source without executing it:

   ```sh
   mkdir -p .context
   /usr/bin/osacompile -l JavaScript -o .context/mail.scpt src/mail_app_mcp/mail.js
   ```

5. Validate the package and Home Manager module:

   ```sh
   nix flake check --print-build-logs
   ```

`flake.lock` pins the build inputs. macOS is the only supported platform, with flake packages for Apple Silicon and Intel Macs. The Home Manager module works within nix-darwin. CI runs the flake checks and compiles JXA on macOS. When working inside Ensemblr, submit installs, tests, and builds through its compute queue.

Tests must not open Mail, read real accounts, or mutate live messages. Replace the external Mail boundary in tests. `create_server` opens Mail's real index only when it is given the Mail data folder, which `main` does; index tests build their own index file and pass that folder. Keep production dispatch fixed; do not add an environment variable or configuration option that replaces it with caller-controlled scripts.

## Code locations

| Path | Responsibility |
| --- | --- |
| `src/mail_app_mcp/server.py` | FastMCP tools, startup configuration, write coordination. |
| `src/mail_app_mcp/models.py` | Validated references, draft inputs, and owner move policy. |
| `src/mail_app_mcp/bridge.py` | Fixed subprocess transport and private runtime/lock handling. |
| `src/mail_app_mcp/mail.js` | Mail scripting object lookup and closed operation dispatch. |
| `src/mail_app_mcp/index.py` | Read-only lookup in Mail's message index for `search_messages`, and the fallback to a scan. |
| `src/mail_app_mcp/attachments.py` | Temporary exports and bounded attachment extraction. |
| `src/mail_app_mcp/links.py` | Bounded HTML link extraction from MIME source, without fetching URLs. |
| `tests/` | Python protocol/policy tests and Node fake-Mail tests. |
| `nix/` | Package, Home Manager module, and module checks. |

For a behavior change, test the public tool or external boundary that demonstrates it. Include rejected inputs and cross-account cases, then update `docs/tools.md` if the schema or behavior changes. Python coverage does not measure the JXA implementation; both suites matter.

## Manual acceptance with a disposable account

This checklist is opt-in and is not part of automated tests. Do it only when an operator is present and explicitly chooses to test live Mail. The list, read, draft, reply, and show paths were checked against Mail 16 on macOS 27.2 with a Gmail account. Later field testing on Mail 16/macOS 27.0.1 found native move timeouts and a message removed from INBOX without reaching the requested Gmail label. Trash transfers in the earlier build completed but returned `-1728`. The restored mailbox assignment with fresh verification needs a new live test for both filing and Trash. Use disposable accounts and messages, with no queued or scheduled mail. Mail may connect to providers and sync changes during this procedure.

Record the macOS version, Mail version, account backend, server commit, client launcher, and result for each check. Do not publish real addresses, message contents, or attachment data in test logs.

1. Prepare two disposable accounts with distinguishable test messages, ordinary destination folders, and known actual Trash folders. Open Mail manually, grant Automation to the actual MCP launcher, and verify `list_accounts` and separate `list_mailboxes` calls. Hide Mail or close its windows and confirm a read still works. Start with `{ "accounts": {} }`; verify an ordinary same-account move and automatic Trash discovery, then restore the messages. Re-list after each move.
2. Read only your test mail. Verify mailbox-local search, pagination through `next_offset`, body truncation, extracted HTML links, text/PDF extraction, and a small binary attachment's base64 output. Check that oversized or unavailable MIME source marks links incomplete while preserving the plain-text read, and raw source is absent from results. A not-downloaded or oversized attachment must fail without returning a local path. Confirm that changing account or mailbox fields in a reference cannot select another account's message.
3. Create one plain-text draft and one reply draft, testing the default hidden-window behavior and explicit `open_window: true`. Inspect Mail manually: verify sender, account, recipients, body, reply quote/threading, and saved draft location. Confirm the reply has no automatic account signature; a signature explicitly supplied in `body` must remain. Test `show_message` on those exact items; stale draft IDs must fail without creating another draft. Confirm no message was sent. Reject a sender belonging only to the other account. Do not automatically retry if the draft call times out or returns an uncertain result.
4. Change read/flag state on a disposable message and confirm it remains correct after the call returns. Test `allowed_destinations: null`, an explicit list, and `[]`, restarting after each policy change. An explicit Trash override must work without a matching list entry; discovered Trash must obey the list. Verify unlisted, already-current, sending, and Drafts/Sent destinations are rejected. Missing or ambiguous Trash discovery must fail without guessing. Restore test messages manually if a restriction blocks the restore folder. Do not test permanent deletion or sending.
5. Quit Mail manually only after the test changes have settled, then call a read and a show tool. Confirm the read launches Mail hidden without stealing focus; confirm the explicit show tool brings Mail forward. Repeat a read with Mail already visible and verify its visibility is unchanged. Check startup failures leave the MCP connection open. If a write ever reports an uncertain outcome, stop writes and follow the [recovery procedure](setup.md#recover-after-an-uncertain-write). Record failures as compatibility issues before using a real account.

Do not enable production use solely because offline tests pass. In particular, sender/account binding and saved draft behavior need observation in the actual Mail version and backend you intend to use.

## Search performance acceptance

With the operator-approved disposable accounts, run `search_messages` with a known sender and `limit: 1` once cold and three times warm. Record client wall time and `timing_ms`, mailbox/candidate counts, macOS/Mail version, and backend without logging message contents. Confirm the newest result against Mail across both accounts, including messages with out-of-order mailbox positions and duplicate labels. Compare the same scope with a complete legacy search; a partial legacy page is not equivalent. The offline tests verify Mail-side filtering and bounded summary hydration, but do not establish real Apple-event latency.

For index search, grant Full Disk Access to the launcher and confirm that results report `"backend": "index"`. Compare the messages, their order, `has_more`, and every ref with a scan of the same scope. A server started without Full Disk Access produces that scan.

The index layout is private to Apple, so repeat this comparison after a macOS upgrade. On Mail 16 and macOS 27.0.1, with three Gmail accounts, one other IMAP account, and On My Mac, the index and Mail's scripting agreed on message IDs, mailbox membership, received dates, subjects, and read and flagged state for all 34,601 listings in 42 mailboxes. Two fields differed in form. Mail's scripting quoted a sender's display name when it contained a comma, which `sender_text` reproduces. After a restart of Mail it also quoted the dotted one-word name of one message that it had reported unquoted before, so those quotes depend on Mail's state and an index result can differ from a scan in them. For 92 redirected messages it reported the Resent-Message-ID where the index stores the Message-ID, so Mail supplies the header ID of every returned message. Exchange and POP stores have not been compared; do that before adding their URL schemes to `SCHEMES` in `index.py`.
