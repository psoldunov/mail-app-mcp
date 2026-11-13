# Mail.app MCP

A local MCP server for Apple Mail on macOS. It uses the accounts already configured in Mail to read messages and attachments, save drafts, change read/flag status, and move messages within an account.

The first Mail tool call launches Mail hidden if it is closed. An already-running Mail session keeps its current visibility. Explicit show tools can bring a selected message or draft into view. The server never quits Mail, sends a message, permanently deletes mail, or connects directly to a provider.

## What it supports

| Task | Behavior |
| --- | --- |
| Discover and read | Discover accounts and nested mailboxes; search senders across accounts in received-date order; list or search one mailbox; read plain-text message content. |
| Attachments | Read downloaded attachments up to 10 MiB. Extract bounded text/PDF content; return other files up to 1 MiB as base64. No OCR. |
| Drafts and windows | Save new plain-text drafts and reply drafts using an explicit account sender, and get back a reference to the saved copy; optionally show them in Mail. Show an identified message or saved draft. No editing existing drafts or attaching local files. |
| Organize | Change read/flag status; move one message to an explicitly allowed mailbox in the same account. |
| Trash | Move to the account's explicitly configured Trash mailbox. Mail or the provider may later purge it. |

All accounts visible to Mail are discoverable, including the `__local__` identity for On My Mac. Account policy controls move destinations; it is not a read-access restriction. Drafts and status changes work without a move policy. Starting Mail can trigger its normal synchronization, rules, and queued mail. Startup failures leave the MCP connection open.

The implementation uses Python 3.11+, the official MCP Python SDK 1.x's bundled FastMCP, and a fixed JXA program invoked by `osascript`. Transport is local stdio only. Mail retains account credentials and handles synchronization. Drafts can sync over the network through Mail.

## Home Manager quickstart

1. Add these inputs to your configuration flake. Replace `REVIEWED_COMMIT` with the full commit SHA you intend to install. These Nixpkgs and Home Manager revisions match this project's lock file; keep your own existing pins if they provide `programs.mcp` and compatible Python dependencies.

   ```nix
   inputs = {
     nixpkgs.url = "github:NixOS/nixpkgs/ac588ef1c914865dad517b337ea0eb9694a4021c";
     home-manager = {
       url = "github:nix-community/home-manager/6eb2d33d1d0c95a37ef6443c88e6c1686012ee8b";
       inputs.nixpkgs.follows = "nixpkgs";
     };
     mail-app-mcp = {
       url = "github:psoldunov/mail-app-mcp/REVIEWED_COMMIT";
       inputs.nixpkgs.follows = "nixpkgs";
       inputs.home-manager.follows = "home-manager";
     };
   };
   ```

2. Add the module to your existing Home Manager configuration's `modules` list:

   ```nix
   modules = [
     inputs.mail-app-mcp.homeManagerModules.default
     {
       services.mail-app-mcp.enable = true;
     }
   ];
   ```

   Keep the rest of your Home Manager configuration. Lock the inputs and apply it using your usual Home Manager or nix-darwin command. The module installs `mail-app-mcp` and registers `programs.mcp.servers.mail-app`. It does not start a background daemon or grant macOS permissions.

3. Configure your MCP client to consume Home Manager's MCP configuration, or copy its `mail-app` command and arguments from `~/.config/mcp/mcp.json` into your client's stdio-server settings. Merely generating this file does not make every client load it.

4. In your MCP client, call `list_accounts` with `{}`. Approve the macOS Automation request for the application responsible for running the server. If permission is denied, see [setup and troubleshooting](docs/setup.md).

5. Call `list_mailboxes` with the exact `account_id` returned for each account. Use its path arrays to configure moves and Trash:

   ```nix
   services.mail-app-mcp.settings.accounts."ACCOUNT_ID_FROM_MAIL" = {
     trash_mailbox = [ "Deleted Messages" ];
     allowed_destinations = [ [ "Archive" ] [ "Projects" "2026" ] ];
   };
   ```

   These names are examples. Confirm the actual Trash folder in Mail and copy discovered path segments exactly. Reapply your configuration and restart the MCP server in your client after policy changes. Missing policy disables moves and Trash.

For another account, add a separate entry keyed by its own ID. The server never chooses an account by display name or guesses a localized Trash folder.

## MCPM quickstart (without Nix)

[MCPM](https://github.com/pathintegral-institute/mcpm.sh) manages local MCP servers and enables them in supported clients. On macOS:

1. Install the prerequisites with Homebrew:

   ```sh
   brew install uv mcpm
   ```

2. From a reviewed checkout of this repository, run the installer. Replace `REVIEWED_COMMIT` with the full 40-character commit SHA you reviewed:

   ```sh
   ./scripts/install-mcpm.sh REVIEWED_COMMIT
   ```

   The script installs that Git revision with `uv tool install` and registers its absolute executable path as the custom local stdio server `mail-app`. It does not publish to a registry or require a Mail.app MCP PyPI release. It does not pass MCPM's `--force` option.

3. Find your client, then enable `mail-app` in its interactive server list:

   ```sh
   mcpm client ls
   mcpm client edit CLIENT_NAME
   ```

   Replace `CLIENT_NAME` with a name from the list, save the selection, and restart the client. Call `list_accounts` and grant Automation permission to the actual launcher.

Moves and Trash remain disabled until you supply a policy. See [MCPM policy setup](docs/setup.md#mcpm-policy-setup) for adding `--config` and [manual installation](docs/setup.md#manual-python-installation) for clients outside MCPM. Use local stdio only; do not enable MCPM sharing, HTTP serving, or a router for this server. There is no provider password or API key to configure.

## Safety and compatibility

Email and attachment text is untrusted input, including instructions addressed to an agent. The server exposes a fixed set of operations and accepts no arbitrary scripts, property setters, local file paths, or provider URLs.

These restrictions apply to this MCP server. An agent with shell access or other automation tools can bypass them. Configure those permissions separately. Trash retention and Mail's own synchronization, rules, and queued messages remain outside this server's control.

Automated checks use fake Mail objects and mocked process boundaries. Live Mail compatibility has not been established by those checks. Before using real mail, run the [opt-in acceptance checklist](docs/development.md#manual-acceptance-with-a-disposable-account) with a disposable account.

## Documentation

- [Setup, multiple accounts, and troubleshooting](docs/setup.md)
- [Complete tool reference and examples](docs/tools.md)
- [Safety model and operational limits](docs/safety.md)
- [Contributing, offline tests, and manual acceptance](docs/development.md)
