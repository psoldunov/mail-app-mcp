# EventKit through the existing osascript program

Calendar and Reminders are reached through EventKit, called over the JXA Objective-C bridge from the same fixed osascript program that drives Mail. Calendar scripting was measured against it on the owner's Mac (macOS 27.2.1, 2026-11-17) and lost on every count: 30 days of events took 4.7 s and returned 45 series masters where EventKit returned all 66 occurrences in under 0.1 s, and reading three fields of those 45 events took 34 s. Only EventKit exposes accounts, time zones and single occurrences of a repeating event. Calendar scripting also failed to return any calendar's identifier, and calendar names are not unique.

Reminders' flag has no EventKit property, so that one field goes through Reminders scripting.

## Considered options

- Calendar and Reminders scripting only. No new permission type, but slow, limited to whole-series edits, and unable to address a calendar reliably.
- PyObjC inside the server process. The pinned nixpkgs has no EventKit binding, and the permission identity is no better than with osascript.
- A compiled helper with its own bundle identifier. It would hold one permission entry shared by every MCP client, but it needs a signed binary built by Nix and the private `responsibility_spawnattrs_setdisclaim` launch call. It remains the upgrade path if per-client prompts become a nuisance.

## Consequences

- macOS grants Calendars and Reminders access to the app that launched the MCP client, so each client is asked once, separately, as it is for Mail automation.
- Under JXA the completion handler of `requestFullAccessToEvents` never fires. The script requests access and then polls the authorization status.
- One EventKit query covers at most four years, so longer ranges are paged.
