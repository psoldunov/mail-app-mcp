# One server, every tool prefixed by its app

The project grows from Mail to four apps: Mail, Calendar, Reminders and Notes. One MCP server, `apple-apps`, serves all of them, and every tool name starts with its app: `mail_list_accounts`, `calendar_list_events`, `reminders_list_lists`, `notes_read_note`. Each app has its own accounts, so an unprefixed `list_accounts` would be ambiguous, and the owner chose one server to install and configure over one per app. The project is renamed from `mail-app-mcp` to `apple-apps-mcp` at the same time.

## Considered options

- One MCP server per app from the same executable (`mail-app`, `calendar-app` and so on). Mail's tool names would have stayed as they were, and a client could enable each app separately. Rejected in favour of a single server.
- One server with only the new tools prefixed. Mail's names would have survived, at the cost of two naming schemes in one tool list.

## Consequences

- Mail's fifteen tool names, the executable, the Home Manager option and the server key all change in one release, with a migration section in the docs and no aliases for the old names.
- A client sees every enabled app's tools at once. The `apps` setting lets an owner register only some apps; all four are on by default.
