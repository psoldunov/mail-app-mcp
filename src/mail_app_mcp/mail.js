'use strict';

var OPERATIONS = ['list_accounts', 'list_mailboxes', 'trash_destination', 'list_messages', 'search_messages', 'confirm_messages',
  'read_message', 'save_attachment', 'set_message_status', 'move_message', 'create_draft', 'reply_draft', 'show_message'];
// Failures of these leave no uncertain mail state; showing a message only opens a window.
var RETRY_SAFE_OPERATIONS = ['list_accounts', 'list_mailboxes', 'trash_destination', 'list_messages', 'search_messages', 'confirm_messages',
  'read_message', 'save_attachment', 'show_message'];
var MAX_BOXES = 1000;
var MAX_BODY_BYTES = 20 * 1024 * 1024;
var MAX_QUOTE_CHARS = 100000;
var MAX_SOURCE_CHARS = 100000;
var SEARCH_BUDGET_MS = 10000;
// A hidden reply's first saved copy is Mail's own quote; the copy with the scripted body replaced it
// 5-15 s later in live runs.
var SAVED_DRAFT_WAIT_MS = 30000;
// After the second save, five one-second polls without a newer copy settle the returned ref.
var SECOND_SAVE_AFTER_MS = 3000;
var SETTLE_POLLS = 5;
var MAX_SEARCH_MATCHES = 20000;
var STATUS_POLLS = 10;
var STATUS_SETTLE_POLLS = 3;
var MOVE_POLLS = 10;
var MAIL_STARTUP_SECONDS = 15;
// A cold first search over ~40 Gmail mailboxes took 20 s; warm ones take ~4 s. The bridge stops at 60 s.
var GLOBAL_SEARCH_BUDGET_MS = 35000;

function requireValue(condition, message) {
  if (!condition) {
    var error = new Error(message);
    error.safeMessage = true;
    throw error;
  }
}

function string(value) { return typeof value === 'string' && value.length > 0; }
function integer(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function validPath(path) {
  return Array.isArray(path) && path.length > 0 && path.length <= 20 && path.every(string);
}
function validate(operation, args) {
  requireValue(OPERATIONS.indexOf(operation) !== -1, 'Unsupported operation');
  requireValue(args && typeof args === 'object' && !Array.isArray(args), 'Invalid arguments');
  if (['list_mailboxes', 'trash_destination', 'list_messages', 'create_draft'].indexOf(operation) !== -1) {
    requireValue(string(args.account_id), 'Invalid account');
  }
  if (operation === 'list_messages') {
    requireValue(validPath(args.mailbox) && integer(args.offset, 0, Number.MAX_SAFE_INTEGER) &&
      integer(args.limit, 1, 100) && typeof args.query === 'string' &&
      typeof args.search_body === 'boolean', 'Invalid message search');
  }
  if (operation === 'search_messages') {
    requireValue(typeof args.from === 'string' && args.from.length <= 1000 &&
      ['newest', 'oldest'].indexOf(args.sort) !== -1 && integer(args.limit, 1, 100) &&
      (args.account_id == null || string(args.account_id)) &&
      (args.mailbox == null || (string(args.account_id) && validPath(args.mailbox))) &&
      (args.after == null || (Array.isArray(args.after) && args.after.length === 3 && Number.isSafeInteger(args.after[0]) &&
        string(args.after[1]) && integer(args.after[2], 1, Number.MAX_SAFE_INTEGER))) &&
      (args.received_after == null || Number.isSafeInteger(args.received_after)) &&
      (args.received_before == null || Number.isSafeInteger(args.received_before)) &&
      (args.received_after == null || args.received_before == null || args.received_after < args.received_before),
    'Invalid global search');
  }
  if (operation === 'confirm_messages') {
    requireValue(Array.isArray(args.messages) && args.messages.length >= 1 && args.messages.length <= 100 &&
      args.messages.every(function (item) {
        return item && string(item.account_id) && validPath(item.mailbox) &&
          integer(item.message_id, 1, Number.MAX_SAFE_INTEGER) && Number.isSafeInteger(item.timestamp);
      }), 'Invalid confirmation request');
  }
  if (['read_message', 'save_attachment', 'set_message_status', 'move_message', 'reply_draft', 'show_message'].indexOf(operation) !== -1) {
    var ref = args.ref;
    requireValue(ref && string(ref.account_id) && validPath(ref.mailbox) &&
      integer(ref.message_id, 1, Number.MAX_SAFE_INTEGER) && typeof ref.header_message_id === 'string' &&
      ref.header_message_id.length <= 2048, 'Invalid reference');
  }
  if (operation === 'read_message') requireValue(integer(args.max_chars, 1, 100000), 'Invalid body limit');
  if (operation === 'save_attachment') {
    requireValue(string(args.attachment_id) && string(args.path) && args.path[0] === '/' &&
      args.path.indexOf('\0') === -1 && integer(args.max_bytes, 1, Number.MAX_SAFE_INTEGER), 'Invalid attachment request');
  }
  if (operation === 'move_message') requireValue(validPath(args.destination), 'Invalid destination');
  if (operation === 'set_message_status') {
    requireValue([args.read, args.flagged].every(function (value) { return value == null || typeof value === 'boolean'; }) &&
      (typeof args.read === 'boolean' || typeof args.flagged === 'boolean'), 'Invalid status');
  }
  if (operation === 'create_draft' || operation === 'reply_draft') validateDraft(operation, args);
}

function address(value) {
  return typeof value === 'string' && value.length <= 320 && /^[^\s<>@,;\x00-\x1f]+@[^\s<>@,;\x00-\x1f]+$/.test(value);
}

function validateDraft(operation, args) {
  requireValue(address(args.sender), 'Invalid sender');
  requireValue(typeof args.body === 'string' && args.body.length <= 100000, 'Invalid draft body');
  requireValue(args.open_window === undefined || typeof args.open_window === 'boolean', 'Invalid window option');
  if (operation === 'reply_draft') {
    requireValue(typeof args.reply_all === 'boolean', 'Invalid reply mode');
  } else {
    requireValue(typeof args.subject === 'string' && args.subject.length <= 998 &&
      !/[\r\n\0]/.test(args.subject), 'Invalid subject');
    requireValue([args.to, args.cc, args.bcc].every(function (items) {
      return Array.isArray(items) && items.length <= 100 && items.every(address);
    }) && args.to.length > 0, 'Invalid recipients');
  }
}

function one(items, label) {
  requireValue(items.length === 1, label + ' missing or ambiguous');
  return items[0];
}

function accountFor(mail, id) {
  requireValue(id !== '__local__', 'Local account cannot compose');
  var account = one(mail.accounts.whose({ id: id })(), 'Account');
  requireValue(account.id() === id, 'Account identity changed');
  return account;
}

function boxIdentity(box) {
  var account = box.account();
  var path = [box.name()];
  var parent = box.container();
  while (parent) {
    // Mail returns an account container, not null, at the top of a mailbox path.
    if (account && Automation.getDisplayString(parent) === Automation.getDisplayString(account)) break;
    if (!account && !parent.exists()) break;
    requireValue(path.length < 20, 'Mailbox hierarchy too deep');
    path = [parent.name()].concat(path);
    parent = parent.container();
  }
  return { account_id: account ? account.id() : '__local__', mailbox: path };
}

function sameBox(box, accountId, path) {
  var identity = boxIdentity(box);
  return identity.account_id === accountId && JSON.stringify(identity.mailbox) === JSON.stringify(path);
}

function accountBoxes(mail, accountId) {
  var boxes = accountId === '__local__' ? mail.mailboxes() : accountFor(mail, accountId).mailboxes();
  requireValue(boxes.length <= MAX_BOXES, 'Mailbox hierarchy too large');
  return boxes.filter(function (box) { return boxIdentity(box).account_id === accountId; });
}

function boxFor(mail, accountId, path) {
  var box = one(accountBoxes(mail, accountId).filter(function (candidate) {
    return sameBox(candidate, accountId, path);
  }), 'Mailbox');
  requireValue(sameBox(box, accountId, path), 'Mailbox identity changed');
  return box;
}

function messageFor(mail, ref) {
  // A ref may name any mailbox that lists the message, such as a Gmail label stored in All Mail.
  var box = boxFor(mail, ref.account_id, ref.mailbox);
  var rediscover = '; call list_messages again and use the fresh ref. Draft autosave can change both IDs';
  var matches = box.messages.whose({ id: ref.message_id })();
  requireValue(matches.length === 1, 'Message missing or ambiguous' + rediscover);
  var message = matches[0];
  requireValue(message.id() === ref.message_id && message.messageId() === ref.header_message_id,
    'Message reference is stale' + rediscover);
  return message;
}

function listAccounts(mail) {
  return { accounts: mail.accounts().map(function (account) {
    return { account_id: account.id(), name: account.name(), email_addresses: account.emailAddresses() };
  }).concat([{ account_id: '__local__', name: 'On My Mac', email_addresses: [] }]) };
}

function listMailboxes(mail, args) {
  var result = accountBoxes(mail, args.account_id).map(function (box) {
    var identity = boxIdentity(box);
    requireValue(identity.account_id === args.account_id, 'Mailbox identity changed');
    return { account_id: args.account_id, path: identity.mailbox, unread_count: box.unreadCount() };
  });
  return { mailboxes: result };
}

function trashDestination(mail, args) {
  var boxes = accountBoxes(mail, args.account_id);
  var paths = [];
  var visited = 0;
  function visit(box, depth) {
    if (!box) return;
    visited += 1;
    requireValue(visited <= MAX_BOXES && depth <= 20, 'Trash mailbox hierarchy too large');
    var account = box.account();
    // The account-less root is virtual All Trash; only its descendants can identify local Trash.
    if ((account || depth > 0) && (account ? account.id() : '__local__') === args.account_id) {
      paths = paths.concat([boxIdentity(box).mailbox]);
      return; // Ordinary subfolders inside Trash are not alternative Trash destinations.
    }
    box.mailboxes().forEach(function (child) { visit(child, depth + 1); });
  }
  visit(mail.trashMailbox(), 0);
  var box = one(boxes.filter(function (candidate) {
    return paths.some(function (path) { return sameBox(candidate, args.account_id, path); });
  }), 'Trash mailbox');
  return { account_id: args.account_id, destination: boxIdentity(box).mailbox };
}

function summary(message, accountId, mailbox) {
  return { ref: { account_id: accountId, mailbox: mailbox,
    message_id: message.id(), header_message_id: message.messageId() },
  subject: message.subject(), sender: message.sender(), date_received: message.dateReceived().toISOString(),
  read: message.readStatus(), flagged: message.flaggedStatus() };
}

function bulkIds(messages) {
  try { return messages.id(); }
  catch (error) {
    // Mail cannot bulk-read some empty special mailboxes, such as Gmail's Notes, but counts them as empty.
    if (error.errorNumber === -1728 && messages.length === 0) return [];
    throw error;
  }
}

function mailboxSnapshot(box) {
  // One whole-mailbox property read is a single Apple event; index and range reads cost one per message.
  var messages = box.messages;
  var ids = bulkIds(messages);
  if (!ids.length) return { ids: [], subjects: [], senders: [], dates: [], read: [], flagged: [], messageIds: [] };
  var snapshot = { ids: ids, subjects: messages.subject(), senders: messages.sender(),
    dates: messages.dateReceived(), read: messages.readStatus(), flagged: messages.flaggedStatus(),
    messageIds: messages.messageId() };
  requireValue(Object.keys(snapshot).every(function (key) {
    return Array.isArray(snapshot[key]) && snapshot[key].length === ids.length;
  }) && snapshot.subjects.concat(snapshot.senders).every(function (value) { return typeof value === 'string'; }) &&
    JSON.stringify(messages.id()) === JSON.stringify(ids), 'Mailbox changed while listing; list messages again');
  return snapshot;
}

function snapshotMatches(box, snapshot, index, query, searchBody) {
  if (snapshot.subjects[index].toLowerCase().indexOf(query) !== -1 ||
    snapshot.senders[index].toLowerCase().indexOf(query) !== -1) return true;
  if (!searchBody) return false;
  var message = box.messages.byId(snapshot.ids[index]);
  checkBodySize(message);
  return message.content().toLowerCase().indexOf(query) !== -1;
}

function listMessages(mail, args) {
  var box = boxFor(mail, args.account_id, args.mailbox);
  var snapshot = mailboxSnapshot(box);
  // The budget bounds per-message body reads; header matching is local and covers the whole mailbox.
  var deadline = Date.now() + SEARCH_BUDGET_MS;
  var total = snapshot.ids.length;
  var start = Math.min(args.offset, total);
  var query = args.query.toLowerCase();
  var found = [];
  var stopped = 'end';
  var index = start;
  for (; index < total; index += 1) {
    if (found.length >= args.limit) { stopped = 'limit'; break; }
    if (index > start && Date.now() >= deadline) { stopped = 'time_budget'; break; }
    if (snapshotMatches(box, snapshot, index, query, args.search_body)) {
      // Refs keep the listed mailbox; Gmail stores label views such as INBOX in All Mail.
      found = found.concat([{ ref: { account_id: args.account_id, mailbox: args.mailbox,
        message_id: snapshot.ids[index], header_message_id: snapshot.messageIds[index] },
      subject: snapshot.subjects[index], sender: snapshot.senders[index],
      date_received: snapshot.dates[index].toISOString(), read: snapshot.read[index], flagged: snapshot.flagged[index] }]);
    }
  }
  return { messages: found, next_offset: index < total ? index : null, complete: index >= total,
    scanned: index - start, stopped: stopped };
}

// Gmail lists one message under several labels; refs prefer INBOX, then other labels, then All Mail.
function labelRank(name) {
  var normalized = String(name).toLowerCase();
  return normalized === 'inbox' ? 0 : normalized === 'all mail' ? 2 : 1;
}

function searchBoxes(mail, args) {
  if (args.mailbox) {
    return [{ box: boxFor(mail, args.account_id, args.mailbox), account_id: args.account_id, rank: 0 }];
  }
  var accounts = args.account_id === '__local__' ? [] :
    (args.account_id ? [accountFor(mail, args.account_id)] : mail.accounts());
  var boxes = accounts.reduce(function (result, account) {
    var id = account.id();
    var items = account.mailboxes();
    requireValue(result.length + items.length <= MAX_BOXES, 'Search scope exceeds 1000 mailboxes; narrow account_id or mailbox');
    var names = account.mailboxes.name();
    return result.concat(items.map(function (box, index) {
      return { box: box, account_id: id, rank: labelRank(names[index]) };
    }));
  }, []);
  if (!args.account_id || args.account_id === '__local__') {
    var local = mail.mailboxes();
    requireValue(local.length <= MAX_BOXES, 'Local mailbox inventory exceeds 1000 mailboxes');
    boxes = boxes.concat(local.filter(function (box) { return !box.account(); }).map(function (box) {
      return { box: box, account_id: '__local__', rank: 1 };
    }));
  }
  requireValue(boxes.length <= MAX_BOXES, 'Search scope exceeds 1000 mailboxes; narrow account_id or mailbox');
  return boxes;
}

function searchDeadline(deadline) {
  requireValue(Date.now() < deadline, 'Search time limit exceeded; latest match not established. Narrow account_id or mailbox and retry');
}

function searchCandidates(scope, args, remaining) {
  // Whole-mailbox reads filtered here; Mail's whose clause rescans the mailbox for every property read.
  // Subjects and bodies of nonmatches are never fetched.
  var sender = args.from;
  var messages = scope.box.messages;
  var ids = bulkIds(messages);
  if (!ids.length) return [];
  var senders = sender ? messages.sender() : ids;
  var dates = messages.dateReceived();
  requireValue(Array.isArray(ids) && Array.isArray(senders) && Array.isArray(dates) &&
    senders.length === ids.length && dates.length === ids.length &&
    JSON.stringify(messages.id()) === JSON.stringify(ids), 'Mailbox changed while searching; retry search');
  var needle = sender.toLowerCase();
  var matches = ids.map(function (id, index) { return index; }).filter(function (index) {
    return !sender || (typeof senders[index] === 'string' && senders[index].toLowerCase().indexOf(needle) !== -1);
  }).map(function (index) {
    var date = dates[index];
    requireValue(integer(ids[index], 1, Number.MAX_SAFE_INTEGER) && date && typeof date.getTime === 'function' &&
      Number.isFinite(date.getTime()), 'Invalid message ID or received date; latest match not established');
    return { scope: scope, id: ids[index], timestamp: date.getTime() };
  }).filter(function (candidate) {
    // after is inclusive and before exclusive, as in the index search.
    return (args.received_after == null || candidate.timestamp >= args.received_after) &&
      (args.received_before == null || candidate.timestamp < args.received_before);
  });
  requireValue(matches.length <= remaining,
    'Search exceeds 20000 matching headers; narrow account_id, mailbox, from, after or before');
  return matches;
}

function searchMessages(mail, args) {
  var started = Date.now();
  var deadline = started + GLOBAL_SEARCH_BUDGET_MS;
  var boxes = searchBoxes(mail, args);
  searchDeadline(deadline);
  var discovered = Date.now();
  var candidates = boxes.reduce(function (result, scope) {
    searchDeadline(deadline);
    return result.concat(searchCandidates(scope, args, MAX_SEARCH_MATCHES - result.length));
  }, []);
  var unique = candidates.slice().sort(function (a, b) {
    return a.scope.account_id.localeCompare(b.scope.account_id) || a.id - b.id || a.scope.rank - b.scope.rank;
  }).filter(function (candidate, index, all) {
    var previous = all[index - 1];
    if (!previous || previous.scope.account_id !== candidate.scope.account_id || previous.id !== candidate.id) return true;
    requireValue(previous.timestamp === candidate.timestamp, 'Duplicate message dates changed; retry search');
    return false;
  });
  var order = function (a, b) {
    var dateOrder = args.sort === 'newest' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp;
    // Within one account, a higher Mail ID arrived later, so it breaks a received-time tie.
    return dateOrder || a.scope.account_id.localeCompare(b.scope.account_id) ||
      (args.sort === 'newest' ? b.id - a.id : a.id - b.id);
  };
  // A later page keeps only what sorts after the previous page's last message, in the index's order too.
  var after = args.after && { timestamp: args.after[0], scope: { account_id: args.after[1] }, id: args.after[2] };
  var ordered = unique.slice().sort(order).filter(function (candidate) { return !after || order(after, candidate) < 0; });
  searchDeadline(deadline);
  var filtered = Date.now();
  var found = [];
  var paths = new Map();
  for (var index = 0; index < ordered.length && found.length < args.limit; index += 1) {
    searchDeadline(deadline);
    var candidate = ordered[index];
    // byId is a direct reference; a whose lookup would rescan the mailbox for each result.
    var message = candidate.scope.box.messages.byId(candidate.id);
    if (!paths.has(candidate.scope)) paths.set(candidate.scope, boxIdentity(candidate.scope.box).mailbox);
    var item = summary(message, candidate.scope.account_id, paths.get(candidate.scope));
    requireValue(item.ref.message_id === candidate.id && Date.parse(item.date_received) === candidate.timestamp &&
      (!args.from || item.sender.toLowerCase().indexOf(args.from.toLowerCase()) !== -1),
    'Message changed while searching; retry search');
    found = found.concat([item]);
  }
  searchDeadline(deadline);
  return { messages: found.slice(0, args.limit), complete: true, has_more: ordered.length > args.limit,
    sort: args.sort, matched_candidates: candidates.length, mailboxes_searched: boxes.length,
    timing_ms: { discovery: discovered - started, filter_and_sort: filtered - discovered,
      summaries: Date.now() - filtered, total: Date.now() - started } };
}

function confirmMessages(mail, args) {
  // Mail's index nominated these. Mail must still hold each one, and only Mail knows the header ID its
  // scripting reports: a redirected message answers with its Resent-Message-ID, which the index lacks.
  return { header_message_ids: args.messages.map(function (item, index) {
    // Direct references cost no Apple event; a whose lookup rescans the mailbox (about 1 s per 5,000 messages).
    var root = item.account_id === '__local__' ? mail : mail.accounts.byId(item.account_id);
    var message = item.mailbox.reduce(function (container, name) {
      return container.mailboxes.byName(name);
    }, root).messages.byId(item.message_id);
    try {
      // One date comparison per call exposes an index whose layout or clock has drifted from Mail's.
      if (index === 0 && message.dateReceived().getTime() !== item.timestamp) return null;
      return message.messageId();
    } catch (error) {
      if (error.errorNumber !== -1728) throw error;
      return null; // Gone since the index was read, or the index names something Mail does not.
    }
  }) };
}

function attachmentInfo(attachment) {
  var mime;
  try { mime = { mime_type: attachment.mimeType() }; }
  catch (error) {
    if (error.errorNumber !== -10000) throw error;
    // Mail can expose an attachment while its MIME property handler fails.
    mime = { mime_type: 'application/octet-stream',
      warning: 'MIME type unavailable from Mail (apple_script_error_number=-10000); returning binary data.' };
  }
  return Object.assign({}, mime, { attachment_id: attachment.id(), name: attachment.name(),
    size: attachment.fileSize(), downloaded: attachment.downloaded() });
}

function allHeaders(message) {
  try { return message.allHeaders(); }
  catch (error) {
    // Same getter failure as attachment MIME types; Mail's own recipient lists still apply.
    if (error.errorNumber !== -10000) throw error;
    return '';
  }
}

function checkBodySize(message) {
  requireValue(integer(message.messageSize(), 1, MAX_BODY_BYTES),
    'Message size is unknown or exceeds 20 MiB; search headers only or read it manually in Mail');
}

function readMessage(mail, args) {
  var message = messageFor(mail, args.ref);
  checkBodySize(message);
  var content = message.content();
  var source;
  try { source = message.source(); }
  catch (error) {
    if (error.errorNumber !== -10000) throw error;
    // Mail may fail its MIME source getter while plain-text content is still available.
  }
  var sourceComplete = typeof source === 'string' && source.length <= MAX_SOURCE_CHARS;
  return { ref: args.ref, subject: message.subject(), sender: message.sender(),
    to: message.toRecipients().map(function (recipient) { return recipient.address(); }),
    cc: message.ccRecipients().map(function (recipient) { return recipient.address(); }),
    // Mail drops recipients that are the account's own addresses; the server merges them back from headers.
    headers: allHeaders(message),
    source: typeof source === 'string' ? source.slice(0, MAX_SOURCE_CHARS) : undefined,
    source_truncated: !sourceComplete,
    body: content.slice(0, args.max_chars), truncated: content.length > args.max_chars,
    attachments: message.mailAttachments().map(attachmentInfo) };
}

function rejectUnsafeBox(mail, box, destination) {
  var identity = boxIdentity(box);
  requireValue(!identity.mailbox.some(function (name) {
    return /^(outbox|send later)$/i.test(name.trim());
  }), 'Unsafe sending mailbox');
  var specials = [mail.outbox()];
  if (destination) specials = specials.concat([mail.draftsMailbox(), mail.sentMailbox()]);
  var visited = 0;
  function visit(special, depth) {
    if (!special) return;
    visited += 1;
    requireValue(visited <= MAX_BOXES && depth <= 20, 'Special mailbox hierarchy too large');
    requireValue(!sameBox(special, identity.account_id, identity.mailbox), 'Unsafe special mailbox');
    special.mailboxes().forEach(function (child) { visit(child, depth + 1); });
  }
  specials.forEach(function (special) { visit(special, 0); });
}

function mutation(action) {
  try { return action(); }
  catch (error) {
    var failure = new Error('Outcome unknown: mutation was attempted. Do not retry automatically. ' + String(error.message || error).slice(0, 1000));
    failure.safeMessage = true;
    failure.errorNumber = error.errorNumber;
    throw failure;
  }
}

function setStatus(mail, args) {
  var message = messageFor(mail, args.ref);
  rejectUnsafeBox(mail, message.mailbox(), false);
  return mutation(function () {
    if (typeof args.read === 'boolean') message.readStatus = args.read;
    if (typeof args.flagged === 'boolean') message.flaggedStatus = args.flagged;
    var stable = 0;
    for (var poll = 0; poll < STATUS_POLLS; poll += 1) {
      pause(0.5);
      // JXA can return cached properties on the object used for the setters.
      var current = messageFor(mail, args.ref);
      var read = current.readStatus();
      var flagged = current.flaggedStatus();
      var matches = (args.read == null || read === args.read) && (args.flagged == null || flagged === args.flagged);
      stable = matches ? stable + 1 : 0;
      if (stable >= STATUS_SETTLE_POLLS) return { ref: args.ref, read: read, flagged: flagged };
    }
    requireValue(false, 'Status verification failed; requested state did not settle');
  });
}

function moveMessage(mail, args) {
  var message = messageFor(mail, args.ref);
  var destination = boxFor(mail, args.ref.account_id, args.destination);
  rejectUnsafeBox(mail, message.mailbox(), false);
  rejectUnsafeBox(mail, destination, true);
  requireValue(JSON.stringify(args.ref.mailbox) !== JSON.stringify(args.destination), 'Message is already in destination');
  requireValue(string(args.ref.header_message_id), 'A nonempty Message-ID is required to verify a move');
  requireValue(destination.messages.whose({ messageId: args.ref.header_message_id })().length === 0,
    'Destination already contains this Message-ID; overlapping-label moves are unsupported. ' +
    'For Gmail All Mail, archive in Mail instead. No move was attempted');
  requireValue(boxFor(mail, args.ref.account_id, args.ref.mailbox).messages
    .whose({ messageId: args.ref.header_message_id })().length === 1, 'Source Message-ID is ambiguous');
  return mutation(function () {
    // Mail's move command timed out and misfiled a Gmail label move; use its writable mailbox property.
    try { message.mailbox = destination; }
    catch (error) {
      // Mail may invalidate the source specifier after completing the assignment.
      if (error.errorNumber !== -1728) throw error;
    }
    for (var poll = 0; poll < MOVE_POLLS; poll += 1) {
      pause(0.5);
      // A move invalidates the source handle and may give the destination copy a new numeric ID.
      var source = boxFor(mail, args.ref.account_id, args.ref.mailbox);
      var target = boxFor(mail, args.ref.account_id, args.destination);
      var remaining = source.messages.whose({ messageId: args.ref.header_message_id })();
      var arrived = target.messages.whose({ messageId: args.ref.header_message_id })();
      if (remaining.length === 0 && arrived.length === 1) {
        return { account_id: args.ref.account_id, destination: args.destination, moved: true };
      }
    }
    requireValue(false, 'Move verification failed: message must leave the source and exist in the destination. ' +
      'Gmail All Mail may require archiving in Mail; no delete fallback was attempted');
  });
}

function saveAttachment(mail, args) {
  var message = messageFor(mail, args.ref);
  var attachment = one(message.mailAttachments.whose({ id: args.attachment_id })(), 'Attachment');
  var info = attachmentInfo(attachment);
  requireValue(info.attachment_id === args.attachment_id, 'Attachment identity changed');
  requireValue(info.downloaded === true, 'Attachment is not downloaded');
  // Mail.sdef calls fileSize approximate; the Python bridge also checks the saved bytes.
  requireValue(integer(info.size, 0, args.max_bytes), 'Attachment size exceeds limit or is unknown');
  mail.save(attachment, { in: Path(args.path) });
  return Object.assign({ name: info.name, mime_type: info.mime_type, size: info.size },
    info.warning ? { warning: info.warning } : {});
}

function verifySender(mail, accountId, sender) {
  var account = accountFor(mail, accountId);
  requireValue(account.emailAddresses().indexOf(sender) !== -1, 'Sender is not configured on this account');
  // Mail exposes only a sender address on outgoingMessage, not a writable account.
  var owners = mail.accounts().filter(function (candidate) {
    return candidate.emailAddresses().some(function (address) { return address.toLowerCase() === sender.toLowerCase(); });
  });
  requireValue(owners.length === 1 && owners[0].id() === accountId, 'Sender account is ambiguous');
}

function pause(seconds) { $.NSThread.sleepForTimeInterval(seconds); }
function squash(text) { return String(text).replace(/\s+/g, ''); }

function inspectCopy(drafts, id, expected) {
  try {
    var message = drafts.messages.whose({ id: id })().filter(function (candidate) {
      return boxIdentity(candidate.mailbox()).account_id === expected.account_id &&
        squash(candidate.subject()) === squash(expected.subject);
    })[0];
    if (!message) return null;
    if (squash(message.content()).indexOf(squash(expected.body)) === -1) return { copy: null };
    var identity = boxIdentity(message.mailbox());
    return { copy: { message: message, ref: { account_id: identity.account_id, mailbox: identity.mailbox,
      message_id: message.id(), header_message_id: message.messageId() } } };
  } catch (error) {
    // Mail deletes its first copy when the copy with the body replaces it.
    if (error.errorNumber === -1728) return null;
    throw error;
  }
}

function savedCopy(mail, expected, deadline, settlePolls) {
  // Mail writes the saved copy into Drafts asynchronously and may add a signature or line spacing. It can
  // also replace a copy that has the body with another one seconds later, so wait for the newest to settle.
  var drafts = mail.draftsMailbox();
  var withoutBody = false;
  var found = null;
  var stablePolls = 0;
  while (Date.now() < deadline) {
    var seen = drafts.messages.id().filter(function (id) { return expected.known.indexOf(id) === -1; })
      .sort(function (a, b) { return b - a; })
      .map(function (id) { return inspectCopy(drafts, id, expected); })
      .filter(Boolean);
    var match = seen.filter(function (item) { return item.copy; })[0];
    var same = match && found && match.copy.ref.message_id === found.ref.message_id;
    stablePolls = same ? stablePolls + 1 : 0;
    found = match ? match.copy : null;
    if (found && stablePolls >= settlePolls) return found;
    withoutBody = seen.length > 0 && !found;
    pause(found ? 1 : 0.25);
  }
  if (found) return found;
  requireValue(!withoutBody, 'Mail saved this draft without the requested body and did not replace it within ' +
    SAVED_DRAFT_WAIT_MS / 1000 + ' seconds. Check Drafts in Mail before retrying');
  return null;
}

// Runs inside the caller's mutation: a wrong sender or a lost body is a bad saved draft.
function saveDraft(mail, draft, expected) {
  var savedAt = Date.now();
  var deadline = savedAt + SAVED_DRAFT_WAIT_MS;
  mail.save(draft);
  requireValue(draft.sender() === expected.sender, 'Draft sender changed after saving');
  var first = savedCopy(mail, expected, deadline, 0);
  if (!first) return null;
  // Mail finishes the signature after a save, and the hidden window then re-saves the draft about 20 s later
  // under new IDs, which kills the returned ref. A second save once that settles leaves nothing to re-save.
  pause(Math.max(0, savedAt + SECOND_SAVE_AFTER_MS - Date.now()) / 1000);
  mail.save(draft);
  // The second save replaces the first copy; fall back to it only if no newer copy appears in time.
  var known = expected.known.concat([first.ref.message_id]);
  return savedCopy(mail, Object.assign({}, expected, { known: known }), deadline, SETTLE_POLLS) || first;
}

// Runs after the mutation: the draft is saved, so failing to open a window is not an uncertain write.
function draftResult(mail, copy, expected) {
  var result = { status: 'draft', account_id: expected.account_id, sender: expected.sender, ref: copy && copy.ref };
  if (!copy) {
    return Object.assign(result, { warning: 'Saved, but the copy did not appear in Drafts within ' +
      SAVED_DRAFT_WAIT_MS / 1000 + ' seconds' +
      (expected.open_window ? ', so no window was opened' : '') + '. Do not retry; find it with list_messages on Drafts.' });
  }
  if (!expected.open_window) return result;
  try {
    // Mail cannot reshow a hidden compose window, so open the saved copy instead.
    mail.open(copy.message);
    mail.activate();
    return result;
  } catch (error) {
    return Object.assign(result, { warning: 'Saved, but Mail could not open it: ' +
      String(error.message || error).slice(0, 200) + '. Do not retry; open it with show_message.' });
  }
}

// Drafts are composed hidden although Mail keeps a hidden session until it quits: only a session that starts
// visible closes by script, and scripting a visible editor is unsafe. Reading a visible reply's content hung
// Mail's main thread until force quit, and a visible reply ignores content set 0.5 s after it opens.
function createDraft(mail, args) {
  verifySender(mail, args.account_id, args.sender);
  var expected = { account_id: args.account_id, sender: args.sender, subject: args.subject, body: args.body,
    known: mail.draftsMailbox().messages.id(), open_window: args.open_window };
  var draft = mail.OutgoingMessage({ subject: args.subject, content: args.body, sender: args.sender, visible: false });
  var copy = mutation(function () {
    mail.outgoingMessages.push(draft);
    draft.messageSignature = null;
    draft.content = args.body;
    args.to.forEach(function (value) { draft.toRecipients.push(mail.ToRecipient({ address: value })); });
    args.cc.forEach(function (value) { draft.ccRecipients.push(mail.CcRecipient({ address: value })); });
    args.bcc.forEach(function (value) { draft.bccRecipients.push(mail.BccRecipient({ address: value })); });
    return saveDraft(mail, draft, expected);
  });
  return draftResult(mail, copy, expected);
}

function quoted(message) {
  var content = message.content().replace(/￼/g, '');
  var lines = content.slice(0, MAX_QUOTE_CHARS).split(/\r\n|\r|\n/)
    .concat(content.length > MAX_QUOTE_CHARS ? ['[…]'] : []);
  var date = (message.dateSent() || message.dateReceived())
    .toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return 'On ' + date + ', ' + message.sender() + ' wrote:\n\n' +
    lines.map(function (line) { return '> ' + line; }).join('\n');
}

function replyDraft(mail, args) {
  var message = messageFor(mail, args.ref);
  rejectUnsafeBox(mail, message.mailbox(), false);
  verifySender(mail, args.ref.account_id, args.sender);
  // Drafts can also appear under Gmail's canonical All Mail mailbox.
  var drafts = mail.draftsMailbox().messages.whose({ id: args.ref.message_id })();
  requireValue(!drafts.some(function (draft) {
    return boxIdentity(draft.mailbox()).account_id === args.ref.account_id;
  }), 'Cannot reply to a saved draft. Select a received message, or use create_draft for a new draft');
  checkBodySize(message);
  var content = (args.body ? args.body + '\n\n' : '') + quoted(message);
  var expected = { account_id: args.ref.account_id, sender: args.sender, body: args.body,
    known: mail.draftsMailbox().messages.id(), open_window: args.open_window };
  var copy = mutation(function () {
    var draft = mail.reply(message, { openingWindow: false, replyToAll: args.reply_all });
    // Mail opens reply windows regardless of openingWindow, and a visible compose view autosaves its own
    // quote over scripted content. Hidden replies keep scripted content but lose Mail's quote, hence quoted().
    draft.visible = false;
    draft.sender = args.sender;
    draft.messageSignature = null;
    draft.content = content;
    return saveDraft(mail, draft, Object.assign({}, expected, { subject: draft.subject() }));
  });
  return draftResult(mail, copy, expected);
}

function showMessage(mail, args) {
  var message = messageFor(mail, args.ref);
  rejectUnsafeBox(mail, message.mailbox(), false);
  mail.open(message);
  mail.activate();
  return { shown: true };
}

function dispatch(mail, operation, args) {
  validate(operation, args);
  switch (operation) {
  case 'list_accounts': return listAccounts(mail);
  case 'list_mailboxes': return listMailboxes(mail, args);
  case 'trash_destination': return trashDestination(mail, args);
  case 'list_messages': return listMessages(mail, args);
  case 'search_messages': return searchMessages(mail, args);
  case 'confirm_messages': return confirmMessages(mail, args);
  case 'read_message': return readMessage(mail, args);
  case 'save_attachment': return saveAttachment(mail, args);
  case 'set_message_status': return setStatus(mail, args);
  case 'move_message': return moveMessage(mail, args);
  case 'create_draft': return createDraft(mail, args);
  case 'reply_draft': return replyDraft(mail, args);
  case 'show_message': return showMessage(mail, args);
  }
}

function mailProcess() {
  var processes = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.mail');
  if (Number(processes.count) === 0) {
    var workspace = $.NSWorkspace.sharedWorkspace;
    var launchError = Ref();
    var launched = workspace.launchApplicationAtURLOptionsConfigurationError(
      workspace.URLForApplicationWithBundleIdentifier('com.apple.mail'),
      $.NSWorkspaceLaunchWithoutActivation | $.NSWorkspaceLaunchAndHide | $.NSWorkspaceLaunchAsync,
      $.NSDictionary.dictionary, launchError);
    requireValue(Boolean(ObjC.unwrap(launched)), launchError[0]
      ? 'Could not launch Mail hidden: ' + ObjC.unwrap(launchError[0].localizedDescription)
      : 'Could not launch Mail hidden');
    var deadline = Date.now() + 5000;
    do {
      processes = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.mail');
      var candidate = Number(processes.count) === 1 ? processes.objectAtIndex(0) : null;
      if ((candidate && !candidate.terminated && integer(Number(candidate.processIdentifier), 1, Number.MAX_SAFE_INTEGER)) ||
          Number(processes.count) > 1 || Date.now() >= deadline) break;
      $.NSThread.sleepForTimeInterval(0.1);
    } while (true);
  }
  requireValue(Number(processes.count) === 1, 'Mail did not start or its running process is ambiguous');
  var process = processes.objectAtIndex(0);
  requireValue(!process.terminated, 'Mail is no longer running');
  var pid = Number(process.processIdentifier);
  requireValue(integer(pid, 1, Number.MAX_SAFE_INTEGER), 'Invalid running Mail process');
  // shortcut: launch age is a conservative settling window; extend if Mail versions need longer.
  var launchDate = process.launchDate;
  requireValue(process.finishedLaunching !== false &&
    (!ObjC.unwrap(launchDate) || Number(launchDate.timeIntervalSinceNow) <= -MAIL_STARTUP_SECONDS),
  'Mail is starting; no operation was attempted. Wait 15 seconds and retry');
  return pid;
}

function run() {
  try {
    ObjC.import('Foundation');
    var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var input = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    var request = JSON.parse(input);
    requireValue(request && typeof request === 'object', 'Invalid request');
    validate(request.operation, request.args);
    ObjC.import('AppKit');
    // A PID target cannot relaunch Mail if it exits between lookup and the Apple event.
    var mail = Application(mailProcess());
    return JSON.stringify({ ok: true, result: dispatch(mail, request.operation, request.args) });
  } catch (error) {
    var operation = request && request.operation;
    var retrySafe = RETRY_SAFE_OPERATIONS.indexOf(operation) !== -1;
    var detail = String(error.message || error).slice(0, 1000);
    return JSON.stringify({ ok: false, operation: operation,
      apple_script_error_number: typeof error.errorNumber === 'number' ? error.errorNumber : null,
      error: error.safeMessage || retrySafe ? detail : 'Outcome unknown: ' + detail });
  }
}

if (typeof module !== 'undefined') module.exports = { dispatch: dispatch };
