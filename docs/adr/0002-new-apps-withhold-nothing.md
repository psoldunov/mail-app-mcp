# Calendar, Reminders and Notes withhold nothing; Mail still does

Mail's tools cannot send or permanently delete, and moves obey an owner policy. Calendar, Reminders and Notes have no such limits, because the owner wants an agent to do in those apps whatever they could do in the app's window. Permanent deletion of events, reminders, calendars and lists, deletion in bulk, inviting attendees and replying to invitations are ordinary tool calls with no confirmation step and no policy switch. Their MCP annotations mark them destructive so a client can prompt if it chooses to.

Mail keeps its boundary unchanged.

## What still applies in every app

- The server accepts only fixed, typed operations. A caller cannot supply a script.
- Writes are serialized and read back, and an uncertain write blocks further writes in the same app until the owner clears it. The lock and the block are separate per app.
- Event, reminder and note text is untrusted data, the same as mail.

Two rules guard against silent loss or leaks without removing a capability:

- A note that holds rich content cannot be rewritten in place, because Notes scripting would destroy its attachments, images, checklist ticks and links. The caller creates a new note and deletes the old one into Recently Deleted.
- A file can be attached to an event only from folders the owner lists in settings.

## Consequences

Text in an invitation from a stranger can ask an agent to delete a calendar or invite someone, and nothing in the server stops an agent that complies. An owner who does not want that exposure switches the app off with the `apps` setting.
