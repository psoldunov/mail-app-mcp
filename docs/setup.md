# Setup and troubleshooting

## Prerequisites and permissions

Live use requires macOS, Apple Mail with accounts already configured, and a local MCP client that can launch a stdio server. A tool call starts Mail hidden when it is closed; an already-running session is left visible or hidden as it was. Mail can synchronize and process queued mail on startup. Only explicit show calls or draft calls with `open_window: true` request an item window and may bring already-running Mail forward.

The first Mail request may prompt for Automation permission. macOS attributes that permission to the responsible application, which can differ between a terminal and an MCP client. Grant access only to the launcher you intend to use. A successful terminal test does not establish permission for a different client.

Check System Settings > Privacy & Security > Automation if a request is denied. Enable Mail access under the application that actually launches the server, then restart that client's server process. The module cannot grant this permission. This implementation does not require access to Mail's private database and does not ask you to grant Full Disk Access.

## Home Manager

Use the pinned input example in [README.md](../README.md). The exported module is `homeManagerModules.default`; import it into a macOS Home Manager configuration, either standalone or embedded in nix-darwin.

| Option | Default | Purpose |
| --- | --- | --- |
| `services.mail-app-mcp.enable` | `false` | Install the package and register the stdio server. macOS only. |
| `services.mail-app-mcp.package` | Flake package for your platform | Override the installed server package. |
| `services.mail-app-mcp.settings.accounts` | `{}` | Map exact Mail account IDs to move policy. |
| `settings.accounts.<id>.trash_mailbox` | `null` | Discover Mail's actual account Trash, or override it with an explicit path. |
| `settings.accounts.<id>.allowed_destinations` | `null` | Permit ordinary same-account destinations, or restrict them with an explicit list of paths. |

The last two options are under `services.mail-app-mcp`. Each mailbox path has 1 to 20 segments; the server accepts at most 100 ordinary destinations per account. The module enables `programs.mcp`, adds the `mail-app` server, and generates a JSON file passed with `--config`. Home Manager writes the common client configuration to `$XDG_CONFIG_HOME/mcp/mcp.json`, normally `~/.config/mcp/mcp.json`. Check whether your client imports that format; otherwise copy the generated command and arguments into its settings.

The generated policy resides in the Nix store. Do not put secrets in it. Account IDs and mailbox names are configuration metadata and may be readable by other local users through the store. No credentials belong in this configuration.

## Policy defaults and migration

Moves do not require a policy file or account entry. Omitting `allowed_destinations` or setting it to `null` permits ordinary destinations in the source account. An explicit list restricts moves to those paths plus an explicit `trash_mailbox` override. `allowed_destinations: []` permits only that override, if one is configured; with no override, it denies every move, including Trash.

Omitted or `null` `trash_mailbox` makes the server discover Mail's actual Trash for the source account. The discovered path must pass the destination policy. Discovery fails if Mail exposes no matching Trash or more than one; it never guesses from folder names. An explicit `trash_mailbox` bypasses discovery and authorizes that path even when it is absent from `allowed_destinations`. Sending, Drafts, and Sent destination guards apply in every case.

When upgrading, keep an old explicit `[]` if you want its restrictions. Removing it or replacing it with `null` permits ordinary same-account moves. Accounts missing from the policy now permit moves, so add an entry with `allowed_destinations: []` and no Trash override for each account whose moves you want to block. Home Manager uses the same defaults. Restart the server after policy changes.

## Discover each account before configuring restrictions

Use tool calls from your MCP client. The JSON below is each tool's argument object.

1. Call `list_accounts`:

   ```json
   {}
   ```

   Keep each returned `account_id` and `email_addresses`. Display names may repeat. The `__local__` account represents On My Mac and cannot create drafts.

2. Call `list_mailboxes` separately for each account:

   ```json
   {"account_id": "ACCOUNT_ID_FROM_MAIL"}
   ```

   Copy returned `path` arrays. `["Projects", "2026"]` means a child mailbox; `["Projects/2026"]` means one mailbox whose name contains a slash. Never split or join paths yourself.

3. To restrict moves, add independent policies. Confirm any explicit Trash override in Mail:

   ```nix
   services.mail-app-mcp.settings.accounts = {
     "WORK_ACCOUNT_ID" = {
       trash_mailbox = [ "Deleted Messages" ];
       allowed_destinations = [ [ "Archive" ] [ "Projects" "2026" ] ];
     };
     "PERSONAL_ACCOUNT_ID" = {
       trash_mailbox = [ "Trash" ];
       allowed_destinations = [ [ "Receipts" ] ];
     };
   };
   ```

   Replace every ID and path. The owner is responsible for identifying the correct Trash override and ordinary destinations. A configured Trash path also permits `move_message` to that path. It does not need to appear again in `allowed_destinations`. For automatic Trash discovery, omit the override and include the actual Trash path in the restricted list.

4. Apply the Home Manager change and restart the MCP server in your client. Test the policy with disposable messages first. A restricted policy must also allow any restore destination, such as Inbox, or you can restore manually in Mail.

Read discovery is not restricted by `settings.accounts`. Draft creation, replies, and status changes do not require an account policy entry. Use client-side tool permissions if you want to withhold these operations from an agent.

## MCPM policy setup

The [MCPM quickstart](../README.md#mcpm-quickstart-without-nix) installs a reviewed Git revision and registers `mail-app` as a custom local stdio server. This project does not require publication in MCPM's registry or on PyPI. Registration does not open Mail or enable the server in a client automatically.

1. Discover account IDs and mailboxes using the tools above, then save a JSON policy using the format below. Choose an absolute file path owned by you.
2. Run `mcpm edit mail-app`. Keep the existing server name and absolute command. In the interactive Arguments field, enter `--config "/Users/you/mail-policy.json"`, replacing the example path. MCPM parses this into `["--config", "/Users/you/mail-policy.json"]`. Review and confirm the change.
3. Run `mcpm client edit CLIENT_NAME` again to apply the server configuration to your client, then restart its MCP server. Check that `mail-app` is enabled and the client uses the updated arguments.

The [upstream MCPM editor](https://github.com/pathintegral-institute/mcpm.sh/blob/main/src/mcpm/commands/edit.py) supports quoted arguments, including paths containing spaces. Policy is trusted startup configuration, not email content. Do not add provider credentials or turn this registration into a remote server. Keep sharing, HTTP serving, and routing disabled.

## Manual Python installation

From a reviewed checkout, install into an isolated environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install .
```

Use the absolute path to `.venv/bin/mail-app-mcp` as your client's stdio command, with optional policy arguments shown below. This route does not use MCPM or modify its configuration.

## JSON policy and client settings

Without Home Manager, create a policy file owned by you:

```json
{
  "accounts": {
    "WORK_ACCOUNT_ID": {
      "trash_mailbox": ["Deleted Messages"],
      "allowed_destinations": [["Archive"], ["Projects", "2026"]]
    },
    "PERSONAL_ACCOUNT_ID": {
      "trash_mailbox": null,
      "allowed_destinations": [["Receipts"]]
    }
  }
}
```

In this policy, the work account allows the two listed destinations and its explicit Trash override. The personal account allows only `Receipts`; its `null` Trash setting triggers discovery, but Trash moves will be denied unless the discovered path is also allowed. Use `allowed_destinations: null` to allow ordinary same-account destinations.

Point your client's stdio-server settings at the installed executable. Clients using the common `mcpServers` format accept this shape:

```json
{
  "mcpServers": {
    "mail-app": {
      "command": "/absolute/path/to/mail-app-mcp",
      "args": ["--config", "/absolute/path/to/mail-policy.json"]
    }
  }
}
```

Use actual absolute paths; do not rely on shell expansion of `~`. Starting the executable directly waits for MCP input on stdin and is not an interactive mail CLI. `mail-app-mcp --help` displays its arguments without touching Mail. Omitting `--config` permits ordinary same-account moves and uses Mail's discovered account Trash. Configuration is read at startup, so restart after edits.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Mail is starting | No operation was attempted. Wait 15 seconds and retry. If Mail remains unready, open it manually to inspect setup prompts. |
| Mail cannot start | The tool reports the startup error while the MCP connection stays open. Open Mail manually to inspect setup or permission prompts, then retry a read. |
| Automation permission denied | Check the responsible launcher under macOS Automation settings. Inspect Mail before repeating any attempted write. |
| `programs.mcp` option is missing | Use a Home Manager revision that provides it, such as the pinned revision in the README. |
| Server is missing in the client | Check that the client consumes Home Manager's configuration or copy the generated command/args into its own settings. |
| Destination is not allowed | Check the account's explicit `allowed_destinations`, including an old `[]`. Add the exact path or use `null` to permit ordinary same-account destinations, then restart. An explicit Trash override is also allowed. Sending, Drafts, and Sent guards still apply. |
| Trash discovery is missing or ambiguous | Confirm the account's actual Trash in Mail and configure its exact path as `trash_mailbox`, then restart. The server does not guess a folder name. |
| Missing, stale, or ambiguous reference | List the source mailbox again and use the newly returned `ref`. Draft autosave can change both IDs; moves and external changes can also invalidate references. |
| Cannot reply to a saved draft | Select a received message, or use `create_draft` for a new standalone draft. Saved drafts cannot be reply sources. |
| A draft call returned `ref: null` with a warning | Mail saved the draft, but its copy did not reach Drafts within 30 seconds. List the Drafts mailbox to find it; do not create another draft. |
| Message size is unknown or exceeds 20 MiB | Use subject/sender search with `search_body: false`, or read/reply manually in Mail. Reducing `max_chars` does not bypass the source-size guard. |
| Attachment is not downloaded | Download it in Mail manually before calling `read_attachment`. |
| Attachment exceeds a limit or PDF extraction fails | Open it yourself in a suitable application. The server does not execute attachments, OCR images, or bypass limits. |
| Runtime directory or lock has unsafe permissions | Inspect `~/Library/Caches/mail-app-mcp` ownership, mode, and symlinks. Its directory must be private (`0700`), with private regular lock/state files. |
| A tool call hangs or the client loses the connection | The server logs each call to stderr as `queued`, `start`, and `end` or `fail` lines with the tool name, duration, and process ID, never the arguments. In the client's MCP log, look for the last `start` without an `end`. Calls run one at a time, so anything queued behind a stuck call waits too. |
| A previous write has an uncertain outcome | Follow the recovery procedure below. The block applies to that MCP server session. Restarting the server starts an unblocked session, but does not confirm or cancel the previous operation. |

### Recover after an uncertain write

An uncertain write blocks further writes in the same MCP server instance. Each instance creates a random session ID at startup and uses its own `write-uncertain-<session-id>` marker in `~/Library/Caches/mail-app-mcp`. Other instances can continue writing, and a restarted server starts unblocked. Opening a new chat may reuse the existing server and its block, depending on the client.

The marker records the operation, its target (message reference, or account and subject for a new draft), start time, process ID, and server build. Error messages include the marker path and recovery steps; subsequent blocked calls also quote its contents and attempt no new write. Uncertain markers remain on disk for inspection after a session ends. New sessions ignore them. Reads and `show_message` remain available in a blocked session.

1. Inspect Mail for the attempted change, using the target in the marker. A timeout or server restart does not cancel a pending Apple event; allow it to finish and reconcile the actual message or draft state. Check before repeating the operation, even from another session.
2. To unblock the existing session after establishing the outcome, remove only the marker named in its error. Alternatively, after checking all recorded operations, run `mail-app-mcp --clear-uncertain`. It acquires the shared write lock, prints the records, removes uncertainty markers for all sessions (including the legacy global marker), and exits. The lock has a five-second wait limit; if another operation holds it longer, try again once that operation finishes. Servers can stay running. Never remove `writes.lock`. No MCP tool clears markers.
3. Rediscover affected messages and decide whether a new write is needed. Never replay draft creation blindly: it can create duplicates. If the outcome remains unknown, keep its marker and investigate manually.

When upgrading, restart all MCP server processes onto the new version. New builds ignore the old global `write-uncertain` marker, leaving it available for inspection and manual clearing. Older builds still honor that global marker and do not understand session markers. All builds continue to share `writes.lock`, which serializes bridge calls but cannot cancel Mail operations that complete after a timeout.
