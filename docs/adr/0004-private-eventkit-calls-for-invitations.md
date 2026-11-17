# Private EventKit calls for invitations; no shortcuts, no UI scripting

Public EventKit cannot add or remove attendees, reply to an invitation, propose a new time, set a video-call link or handle attachments. The server uses EventKit's private selectors for those five features, because more than half of the owner's events have attendees and the owner accepted the risk that Apple changes an undocumented call.

## Considered options

- Signed shortcuts that call the apps' own App Intents. Apple supports this route and it also covers Reminders tags and Notes pinning, but each shortcut needs a manual "Add Shortcut" click and an "Always Allow", a call takes a second or more, and a shortcut finds its item by title and date. Rejected.
- UI scripting through Accessibility. It is the only route to sharing a calendar, list or note, and it breaks across macOS releases and system languages. Rejected.

## Consequences

- Each of the five features is a separate tool that checks its selectors exist before use and fails alone with a clear message when they do not. Tools on public interfaces keep working.
- A `private_calls` setting, on by default, turns all of them off.
- A feature ships only after a write probe shows that it works and syncs. One that fails its probe becomes a documented gap.
- Features with no accepted route stay gaps: travel time in Calendar; tags, sections, list groups and creating subtasks in Reminders (private ReminderKit, deferred until wanted); pinning, locking, tags, checklists and tables in Notes; sharing in all three apps.
