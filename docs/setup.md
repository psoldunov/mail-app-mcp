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
| `settings.accounts.<id>.trash_mailbox` | `null` | Explicit Trash path as a list of segments. |
| `settings.accounts.<id>.allowed_destinations` | `[]` | Lists of mailbox path segments permitted for ordinary moves. |

The last two options are under `services.mail-app-mcp`. Each mailbox path has 1 to 20 segments; the server accepts at most 100 ordinary destinations per account. The module enables `programs.mcp`, adds the `mail-app` server, and generates a JSON file passed with `--config`. Home Manager writes the common client configuration to `$XDG_CONFIG_HOME/mcp/mcp.json`, normally `~/.config/mcp/mcp.json`. Check whether your client imports that format; otherwise copy the generated command and arguments into its settings.

The generated policy resides in the Nix store. Do not put secrets in it. Account IDs and mailbox names are configuration metadata and may be readable by other local users through the store. No credentials belong in this configuration.

## Discover each account before enabling moves

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

3. Confirm the account's actual Trash folder in Mail, then add independent policies:

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

   Replace every ID and path. The owner is responsible for identifying the correct Trash and ordinary destinations. A configured Trash path also permits `move_message` to that path. It does not need to appear again in `allowed_destinations`.

4. Apply the Home Manager change and restart the MCP server in your client. Test the policy with disposable messages first. Restore operations also require the destination, such as Inbox, to be allowlisted, or you can restore manually in Mail.

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

Use actual absolute paths; do not rely on shell expansion of `~`. Starting the executable directly waits for MCP input on stdin and is not an interactive mail CLI. `mail-app-mcp --help` displays its arguments without touching Mail. Omit `--config` to disable moves and Trash, while retaining reads, drafts, and status changes. Configuration is read at startup, so restart after edits.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Mail cannot start | The tool reports the startup error while the MCP connection stays open. Open Mail manually to inspect setup or permission prompts, then retry a read. |
| Automation permission denied | Check the responsible launcher under macOS Automation settings. Inspect Mail before repeating any attempted write. |
| `programs.mcp` option is missing | Use a Home Manager revision that provides it, such as the pinned revision in the README. |
| Server is missing in the client | Check that the client consumes Home Manager's configuration or copy the generated command/args into its own settings. |
| Destination or Trash is not configured | Rediscover that account's mailbox paths, update its policy, then restart the server. |
| Missing, stale, or ambiguous reference | List the source mailbox again and use the newly returned `ref`. Moves and external changes can invalidate IDs. |
| Outgoing draft is no longer available | A `draft_id` can become stale after its window closes or Mail restarts. Locate it manually in Mail; do not create another draft just to show it. |
| Message size is unknown or exceeds 20 MiB | Use subject/sender search with `search_body: false`, or read/reply manually in Mail. Reducing `max_chars` does not bypass the source-size guard. |
| Attachment is not downloaded | Download it in Mail manually before calling `read_attachment`. |
| Attachment exceeds a limit or PDF extraction fails | Open it yourself in a suitable application. The server does not execute attachments, OCR images, or bypass limits. |
| Runtime directory or lock has unsafe permissions | Inspect `~/Library/Caches/mail-app-mcp` ownership, mode, and symlinks. Its directory must be private (`0700`), with private regular lock/state files. |
| A previous write has an uncertain outcome | Follow the recovery procedure below. Restarting the server alone does not clear the block. |

### Recover after an uncertain write

1. Stop all MCP clients' `mail-app-mcp` processes to prevent new operations. Inspect Mail for the attempted change. A timeout does not mean that Mail canceled the Apple event; allow it to finish and reconcile the actual message or draft state.
2. When you have established the outcome, remove only the marker `~/Library/Caches/mail-app-mcp/write-uncertain`. Do not remove the shared `writes.lock` file. No MCP tool clears this marker.
3. Restart your server, rediscover affected messages, and decide whether a new write is needed. Never replay a draft creation blindly: it can create duplicates.

If you cannot establish the outcome, leave the marker in place and investigate manually. Read tools remain available while writes are blocked.
