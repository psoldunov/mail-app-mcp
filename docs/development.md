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

Tests must not open Mail, read real accounts, or mutate live messages. Replace the external Mail boundary in tests. Keep production dispatch fixed; do not add an environment variable or configuration option that replaces it with caller-controlled scripts.

## Code locations

| Path | Responsibility |
| --- | --- |
| `src/mail_app_mcp/server.py` | FastMCP tools, startup configuration, write coordination. |
| `src/mail_app_mcp/models.py` | Validated references, draft inputs, and owner move policy. |
| `src/mail_app_mcp/bridge.py` | Fixed subprocess transport and private runtime/lock handling. |
| `src/mail_app_mcp/mail.js` | Mail scripting object lookup and closed operation dispatch. |
| `src/mail_app_mcp/attachments.py` | Temporary exports and bounded attachment extraction. |
| `tests/` | Python protocol/policy tests and Node fake-Mail tests. |
| `nix/` | Package, Home Manager module, and module checks. |

For a behavior change, test the public tool or external boundary that demonstrates it. Include rejected inputs and cross-account cases, then update `docs/tools.md` if the schema or behavior changes. Python coverage does not measure the JXA implementation; both suites matter.

## Manual acceptance with a disposable account

This checklist is opt-in and is not part of automated tests. Do it only when an operator is present and explicitly chooses to test live Mail. Development of this version did not exercise live Mail. Use disposable accounts and messages, with no queued or scheduled mail. Mail may connect to providers and sync changes during this procedure.

Record the macOS version, Mail version, account backend, server commit, client launcher, and result for each check. Do not publish real addresses, message contents, or attachment data in test logs.

1. Prepare two disposable accounts with distinguishable test messages, ordinary destination folders, and confirmed Trash mappings. Open Mail manually, grant Automation to the actual MCP launcher, and verify `list_accounts` and separate `list_mailboxes` calls. Hide Mail or close its windows and confirm a read still works. Start with `{ "accounts": {} }` and verify that moves and Trash are refused.
2. Read only your test mail. Verify mailbox-local search, pagination through `next_offset`, body truncation, text/PDF extraction, and a small binary attachment's base64 output. A not-downloaded or oversized attachment must fail without returning a local path. Confirm that changing account or mailbox fields in a reference cannot select another account's message.
3. Create one plain-text draft and one reply draft, testing the default hidden-window behavior and explicit `open_window: true`. Inspect Mail manually: verify sender, account, recipients, body, native reply quoting/threading, and saved draft location. Test `show_message` and `show_draft` on those exact items; stale draft IDs must fail without creating another draft. Confirm no message was sent. Reject a sender belonging only to the other account. Do not automatically retry if the draft call times out or returns an uncertain result.
4. Change read/flag state on a disposable message and inspect Mail. Enable one account's exact ordinary destination and Trash paths, restart the server, then test a move and Trash. Re-list after each move. Verify missing policy, an unlisted destination, an already-current destination, and a sending destination are rejected. Restore test messages manually if the restore folder is not allowlisted. Do not test permanent deletion or sending.
5. Quit Mail manually only after the test changes have settled, then call a read and a show tool. Confirm errors without Mail relaunching, the MCP connection staying open, and no retry loop. Open Mail manually and verify that a read works in the same MCP session. If a write ever reports an uncertain outcome, stop writes and follow the [recovery procedure](setup.md#recover-after-an-uncertain-write). Record failures as compatibility issues before using a real account.

Do not enable production use solely because offline tests pass. In particular, sender/account binding and saved draft behavior need observation in the actual Mail version and backend you intend to use.
