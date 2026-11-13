'use strict';

var OPERATIONS = ['list_accounts', 'list_mailboxes', 'list_messages', 'search_messages', 'read_message',
  'save_attachment', 'set_message_status', 'move_message', 'create_draft', 'reply_draft',
  'show_message', 'show_draft'];
var READ_OPERATIONS = ['list_accounts', 'list_mailboxes', 'list_messages', 'search_messages', 'read_message'];
var MAX_BOXES = 1000;
var MAX_BODY_BYTES = 20 * 1024 * 1024;
var MAX_SCAN = 200;
var HEADER_BATCH_SIZE = 10;
var SEARCH_BUDGET_MS = 10000;
var MAX_SEARCH_MATCHES = 20000;
var GLOBAL_SEARCH_BUDGET_MS = 20000;

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
  if (operation === 'list_mailboxes' || operation === 'list_messages' || operation === 'create_draft') {
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
      (args.mailbox == null || (string(args.account_id) && validPath(args.mailbox))), 'Invalid global search');
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
  if (operation === 'show_draft') {
    requireValue(string(args.account_id) && integer(args.draft_id, 0, Number.MAX_SAFE_INTEGER) &&
      address(args.sender), 'Invalid draft identity');
  }
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
  var box = boxFor(mail, ref.account_id, ref.mailbox);
  var message = one(box.messages.whose({ id: ref.message_id })(), 'Message');
  requireValue(message.id() === ref.message_id && message.messageId() === ref.header_message_id,
    'Message reference is stale');
  requireValue(sameBox(message.mailbox(), ref.account_id, ref.mailbox), 'Message mailbox is stale');
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

function summary(message, args) {
  var identity = boxIdentity(message.mailbox());
  requireValue(identity.account_id === args.account_id, 'Message account changed');
  // Gmail label views can enumerate a message whose owning mailbox is All Mail.
  return { ref: { account_id: args.account_id, mailbox: identity.mailbox,
    message_id: message.id(), header_message_id: message.messageId() },
  subject: message.subject(), sender: message.sender(), date_received: message.dateReceived().toISOString(),
  read: message.readStatus(), flagged: message.flaggedStatus() };
}

function headerBatch(box, start, end) {
  // JXA ranges have an inclusive end; fetch only headers from this bounded window.
  var window = box.messages.slice(start, end - 1);
  var subjects = window.subject();
  var senders = window.sender();
  requireValue(Array.isArray(subjects) && Array.isArray(senders) &&
    subjects.length === end - start && senders.length === subjects.length &&
    subjects.concat(senders).every(function (value) { return typeof value === 'string'; }),
  'Mailbox changed while searching; list messages again');
  return { subjects: subjects, senders: senders };
}

function listMessages(mail, args) {
  var deadline = Date.now() + SEARCH_BUDGET_MS;
  var box = boxFor(mail, args.account_id, args.mailbox);
  var total = box.messages.length;
  var index = Math.min(args.offset, total);
  var scanned = 0;
  var found = [];
  var query = args.query.toLowerCase();
  var batch;
  var batchStart = index;
  var batchEnd = index;
  while (index < total && scanned < MAX_SCAN && found.length < args.limit && Date.now() < deadline) {
    if (index === batchEnd) {
      batchStart = index;
      batchEnd = Math.min(index + HEADER_BATCH_SIZE, total, index + MAX_SCAN - scanned);
      batch = headerBatch(box, batchStart, batchEnd);
    }
    var position = index - batchStart;
    var message = box.messages[index];
    index += 1;
    scanned += 1;
    var match = batch.subjects[position].toLowerCase().indexOf(query) !== -1 ||
      batch.senders[position].toLowerCase().indexOf(query) !== -1;
    if (!match && args.search_body) {
      checkBodySize(message);
      match = message.content().toLowerCase().indexOf(query) !== -1;
    }
    if (match) {
      var item = summary(message, args);
      requireValue(item.subject === batch.subjects[position] && item.sender === batch.senders[position],
        'Mailbox changed while searching; list messages again');
      found = found.concat([item]);
    }
  }
  requireValue(scanned > 0 || index >= total, 'Mail took too long to resolve the mailbox; try again later');
  return { messages: found, next_offset: index < total ? index : null, complete: index >= total, scanned: scanned };
}

function searchBoxes(mail, args) {
  if (args.mailbox) return [{ box: boxFor(mail, args.account_id, args.mailbox), account_id: args.account_id }];
  var accounts = args.account_id === '__local__' ? [] :
    (args.account_id ? [accountFor(mail, args.account_id)] : mail.accounts());
  var boxes = accounts.reduce(function (result, account) {
    var id = account.id();
    var items = account.mailboxes();
    requireValue(result.length + items.length <= MAX_BOXES, 'Search scope exceeds 1000 mailboxes; narrow account_id or mailbox');
    return result.concat(items.map(function (box) { return { box: box, account_id: id }; }));
  }, []);
  if (!args.account_id || args.account_id === '__local__') {
    var local = mail.mailboxes();
    requireValue(local.length <= MAX_BOXES, 'Local mailbox inventory exceeds 1000 mailboxes');
    boxes = boxes.concat(local.filter(function (box) { return !box.account(); }).map(function (box) {
      return { box: box, account_id: '__local__' };
    }));
  }
  requireValue(boxes.length <= MAX_BOXES, 'Search scope exceeds 1000 mailboxes; narrow account_id or mailbox');
  return boxes;
}

function searchDeadline(deadline) {
  requireValue(Date.now() < deadline, 'Search time limit exceeded; latest match not established. Narrow account_id or mailbox and retry');
}

function searchCandidates(scope, sender, remaining) {
  // Mail evaluates this predicate; never fetch subjects or bodies for nonmatches.
  var selected = sender ? scope.box.messages.whose({ sender: { _contains: sender } }) : scope.box.messages;
  var count = selected.length;
  requireValue(integer(count, 0, remaining), 'Search exceeds 20000 matching headers; narrow account_id, mailbox or from');
  if (!count) return [];
  var ids = selected.id();
  var dates = selected.dateReceived();
  requireValue(Array.isArray(ids) && Array.isArray(dates) && ids.length === count && dates.length === count &&
    JSON.stringify(selected.id()) === JSON.stringify(ids), 'Mailbox changed while searching; retry search');
  return ids.map(function (id, index) {
    var date = dates[index];
    requireValue(integer(id, 1, Number.MAX_SAFE_INTEGER) && date && typeof date.getTime === 'function' &&
      Number.isFinite(date.getTime()), 'Invalid message ID or received date; latest match not established');
    return { scope: scope, id: id, timestamp: date.getTime() };
  });
}

function searchMessages(mail, args) {
  var started = Date.now();
  var deadline = started + GLOBAL_SEARCH_BUDGET_MS;
  var boxes = searchBoxes(mail, args);
  searchDeadline(deadline);
  var discovered = Date.now();
  var candidates = boxes.reduce(function (result, scope) {
    searchDeadline(deadline);
    return result.concat(searchCandidates(scope, args.from, MAX_SEARCH_MATCHES - result.length));
  }, []);
  var unique = candidates.slice().sort(function (a, b) {
    return a.scope.account_id.localeCompare(b.scope.account_id) || a.id - b.id;
  }).filter(function (candidate, index, all) {
    var previous = all[index - 1];
    if (!previous || previous.scope.account_id !== candidate.scope.account_id || previous.id !== candidate.id) return true;
    requireValue(previous.timestamp === candidate.timestamp, 'Duplicate message dates changed; retry search');
    return false;
  });
  var ordered = unique.slice().sort(function (a, b) {
    var dateOrder = args.sort === 'newest' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp;
    return dateOrder || a.scope.account_id.localeCompare(b.scope.account_id) || a.id - b.id;
  });
  searchDeadline(deadline);
  var filtered = Date.now();
  var found = [];
  for (var index = 0; index < ordered.length && found.length < args.limit; index += 1) {
    searchDeadline(deadline);
    var candidate = ordered[index];
    var message = one(candidate.scope.box.messages.whose({ id: candidate.id })(), 'Search result');
    var item = summary(message, candidate.scope);
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

function checkBodySize(message) {
  requireValue(integer(message.messageSize(), 1, MAX_BODY_BYTES),
    'Message size is unknown or exceeds 20 MiB; search headers only or read it manually in Mail');
}

function readMessage(mail, args) {
  var message = messageFor(mail, args.ref);
  checkBodySize(message);
  var content = message.content();
  return { ref: args.ref, subject: message.subject(), sender: message.sender(),
    to: message.toRecipients().map(function (recipient) { return recipient.address(); }),
    cc: message.ccRecipients().map(function (recipient) { return recipient.address(); }),
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
    var read = message.readStatus();
    var flagged = message.flaggedStatus();
    requireValue((args.read == null || read === args.read) && (args.flagged == null || flagged === args.flagged),
      'Status verification failed');
    return { ref: args.ref, read: read, flagged: flagged };
  });
}

function moveMessage(mail, args) {
  var message = messageFor(mail, args.ref);
  var destination = boxFor(mail, args.ref.account_id, args.destination);
  rejectUnsafeBox(mail, message.mailbox(), false);
  rejectUnsafeBox(mail, destination, true);
  return mutation(function () {
    message.mailbox = destination;
    requireValue(sameBox(message.mailbox(), args.ref.account_id, args.destination) &&
      message.messageId() === args.ref.header_message_id, 'Move verification failed');
    return { account_id: args.ref.account_id, destination: args.destination, moved: true };
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

function openDraftWindow(mail, draft) {
  draft.visible = true;
  mail.activate();
}

function saveDraft(mail, draft, accountId, sender, openWindow) {
  mail.save(draft);
  var id = draft.id();
  requireValue(integer(id, 0, Number.MAX_SAFE_INTEGER) && draft.sender() === sender,
    'Draft outcome unknown; do not retry automatically');
  if (openWindow) openDraftWindow(mail, draft);
  return { draft_id: id, account_id: accountId, sender: sender, status: 'draft' };
}

function createDraft(mail, args) {
  verifySender(mail, args.account_id, args.sender);
  var draft = mail.OutgoingMessage({ subject: args.subject, content: args.body, sender: args.sender, visible: false });
  return mutation(function () {
    mail.outgoingMessages.push(draft);
    args.to.forEach(function (value) { draft.toRecipients.push(mail.ToRecipient({ address: value })); });
    args.cc.forEach(function (value) { draft.ccRecipients.push(mail.CcRecipient({ address: value })); });
    args.bcc.forEach(function (value) { draft.bccRecipients.push(mail.BccRecipient({ address: value })); });
    return saveDraft(mail, draft, args.account_id, args.sender, args.open_window);
  });
}

function replyDraft(mail, args) {
  var message = messageFor(mail, args.ref);
  rejectUnsafeBox(mail, message.mailbox(), false);
  verifySender(mail, args.ref.account_id, args.sender);
  checkBodySize(message);
  return mutation(function () {
    var draft = mail.reply(message, { openingWindow: false, replyToAll: args.reply_all });
    draft.sender = args.sender;
    draft.content = args.body + '\n\n' + draft.content();
    return saveDraft(mail, draft, args.ref.account_id, args.sender, args.open_window);
  });
}

function showMessage(mail, args) {
  var message = messageFor(mail, args.ref);
  rejectUnsafeBox(mail, message.mailbox(), false);
  return mutation(function () {
    mail.open(message);
    mail.activate();
    return { shown: true };
  });
}

function showDraft(mail, args) {
  verifySender(mail, args.account_id, args.sender);
  var draft = one(mail.outgoingMessages.whose({ id: args.draft_id })(), 'Draft');
  requireValue(draft.id() === args.draft_id && draft.sender() === args.sender, 'Draft identity is stale');
  return mutation(function () {
    openDraftWindow(mail, draft);
    return { shown: true, draft_id: args.draft_id, account_id: args.account_id };
  });
}

function dispatch(mail, operation, args) {
  validate(operation, args);
  switch (operation) {
  case 'list_accounts': return listAccounts(mail);
  case 'list_mailboxes': return listMailboxes(mail, args);
  case 'list_messages': return listMessages(mail, args);
  case 'search_messages': return searchMessages(mail, args);
  case 'read_message': return readMessage(mail, args);
  case 'save_attachment': return saveAttachment(mail, args);
  case 'set_message_status': return setStatus(mail, args);
  case 'move_message': return moveMessage(mail, args);
  case 'create_draft': return createDraft(mail, args);
  case 'reply_draft': return replyDraft(mail, args);
  case 'show_message': return showMessage(mail, args);
  case 'show_draft': return showDraft(mail, args);
  }
}

function mailProcess() {
  var processes = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.mail');
  if (Number(processes.count) === 0) {
    var workspace = $.NSWorkspace.sharedWorkspace;
    var launchError = Ref();
    var launched = workspace.launchApplicationAtURLOptionsConfigurationError(
      workspace.URLForApplicationWithBundleIdentifier('com.apple.mail'),
      $.NSWorkspaceLaunchWithoutActivation | $.NSWorkspaceLaunchAndHide,
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
    var readOnly = READ_OPERATIONS.indexOf(operation) !== -1;
    var detail = String(error.message || error).slice(0, 1000);
    return JSON.stringify({ ok: false, operation: operation,
      apple_script_error_number: typeof error.errorNumber === 'number' ? error.errorNumber : null,
      error: error.safeMessage || readOnly ? detail : 'Outcome unknown: ' + detail });
  }
}

if (typeof module !== 'undefined') module.exports = { dispatch: dispatch };
