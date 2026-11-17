# Apple Apps MCP

A local MCP server that lets an agent work in the owner's Apple Mail, Calendar, Reminders and Notes through the accounts those applications already hold.

## Language

### Shared

**App**:
One of the Apple applications the server works in: Mail, Calendar, Reminders or Notes.
_Avoid_: Service, integration, backend

**Owner**:
The person who installs the server, grants its macOS permissions and writes its settings.
_Avoid_: Admin, operator, user

**Caller**:
The MCP client, and the agent behind it, that invokes the server's tools.
_Avoid_: Client, user, agent

**Account**:
An account as one App presents it. The same iCloud or Google account is a separate Account in each App, and its IDs in different Apps are unrelated.
_Avoid_: Source, profile, provider

**Withheld operation**:
Something an App can do that the server deliberately does not offer. Mail withholds sending and permanent deletion; Calendar, Reminders and Notes withhold nothing.
_Avoid_: Restriction, blocked action, gate

**Gap**:
Something an App's window can do that no scripting interface reaches.
_Avoid_: Limitation, unsupported feature, restriction

**Default target**:
The calendar, list or folder an App itself uses for a new item when none is named.
_Avoid_: Fallback, implicit destination

**Uncertain write**:
A write whose result the server could not confirm, so it may or may not have happened.
_Avoid_: Failed write, timeout, unknown outcome

**Private call**:
A use of an Apple interface that Apple neither documents nor supports.
_Avoid_: Hack, internal API, undocumented API

### Calendar

**Calendar**:
A named collection of events inside one Account. Two calendars can share a name.
_Avoid_: Agenda, schedule

**Event**:
An entry in a Calendar with a start and an end.
_Avoid_: Appointment, meeting, entry

**Series**:
An Event that repeats by a rule.
_Avoid_: Recurring event, master

**Occurrence**:
One dated instance of a Series.
_Avoid_: Instance, repetition

**Reach**:
How far a change to a Series extends: one Occurrence, that Occurrence and all later ones, or the whole Series.
_Avoid_: Span, scope

**Attendee**:
A person an Event invites, together with their reply.
_Avoid_: Participant, guest, invitee

**Invitation**:
An Event organized by someone else that lists the Owner as an Attendee.
_Avoid_: Invite, meeting request

### Reminders

**List**:
A named collection of reminders inside one Account, as shown under My Lists in Reminders.
_Avoid_: Reminder list, calendar, collection

### Notes

**Folder**:
A named container of notes inside one Account. Folders can nest.
_Avoid_: Directory, notebook

**Rich content**:
The parts of a note that are lost when its text is replaced: attachments, images, checklists, tables and tags.
_Avoid_: Formatting, media, embedded objects

**Recently Deleted**:
Where Notes keeps a deleted note for 30 days before removing it for good.
_Avoid_: Trash, bin
