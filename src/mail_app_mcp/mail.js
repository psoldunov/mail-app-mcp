'use strict';

var OPERATIONS = ['list_accounts', 'list_mailboxes', 'list_messages', 'read_message',
  'save_attachment', 'set_message_status', 'move_message', 'create_draft', 'reply_draft',
  'show_message', 'show_draft'];
var MAX_BOXES = 1000;
var MAX_BODY_BYTES = 20 * 1024 * 1024;

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
    requireValue(string(args.account_id) && integer(args.draft_id, 1, Number.MAX_SAFE_INTEGER) &&
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

function roots(mail, accountId) {
  var boxes = accountId === '__local__' ? mail.mailboxes() : accountFor(mail, accountId).mailboxes();
  requireValue(boxes.length <= MAX_BOXES, 'Mailbox hierarchy too large');
  return boxes.filter(function (box) { return boxIdentity(box).account_id === accountId; });
}

function boxFor(mail, accountId, path) {
  var boxes = roots(mail, accountId);
  var box;
  path.forEach(function (part, index) {
    box = one(boxes.filter(function (candidate) { return candidate.name() === part; }), 'Mailbox');
    if (index < path.length - 1) {
      boxes = box.mailboxes();
      requireValue(boxes.length <= MAX_BOXES, 'Mailbox hierarchy too large');
    }
  });
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
  var result = [];
  function visit(boxes, prefix) {
    requireValue(prefix.length < 20 || boxes.length === 0, 'Mailbox hierarchy too deep');
    boxes.forEach(function (box) {
      requireValue(result.length < MAX_BOXES, 'Mailbox hierarchy too large');
      var path = prefix.concat([box.name()]);
      requireValue(sameBox(box, args.account_id, path), 'Mailbox identity changed');
      result = result.concat([{ account_id: args.account_id, path: path, unread_count: box.unreadCount() }]);
      visit(box.mailboxes(), path);
    });
  }
  visit(roots(mail, args.account_id), []);
  return { mailboxes: result };
}

function summary(message, args) {
  requireValue(sameBox(message.mailbox(), args.account_id, args.mailbox), 'Message mailbox is stale');
  return { ref: { account_id: args.account_id, mailbox: args.mailbox,
    message_id: message.id(), header_message_id: message.messageId() },
  subject: message.subject(), sender: message.sender(), date_received: message.dateReceived().toISOString(),
  read: message.readStatus(), flagged: message.flaggedStatus() };
}

function listMessages(mail, args) {
  var box = boxFor(mail, args.account_id, args.mailbox);
  var total = box.messages.length;
  var index = Math.min(args.offset, total);
  var scanned = 0;
  var found = [];
  var query = args.query.toLowerCase();
  while (index < total && scanned < 200 && found.length < args.limit) {
    var message = box.messages[index];
    index += 1;
    scanned += 1;
    var match = message.subject().toLowerCase().indexOf(query) !== -1 ||
      message.sender().toLowerCase().indexOf(query) !== -1;
    if (!match && args.search_body) {
      checkBodySize(message);
      match = message.content().toLowerCase().indexOf(query) !== -1;
    }
    if (match) found = found.concat([summary(message, args)]);
  }
  return { messages: found, next_offset: index < total ? index : null, complete: index >= total, scanned: scanned };
}

function attachmentInfo(attachment) {
  return { attachment_id: attachment.id(), name: attachment.name(), mime_type: attachment.mimeType(),
    size: attachment.fileSize(), downloaded: attachment.downloaded() };
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
  catch (error) { requireValue(false, 'Outcome unknown: mutation was attempted. Do not retry automatically.'); }
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
  return { name: info.name, mime_type: info.mime_type, size: info.size };
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
  requireValue(integer(id, 1, Number.MAX_SAFE_INTEGER) && draft.sender() === sender,
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

function run() {
  try {
    ObjC.import('Foundation');
    var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var input = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    var request = JSON.parse(input);
    requireValue(request && typeof request === 'object', 'Invalid request');
    validate(request.operation, request.args);
    ObjC.import('AppKit');
    var processes = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.mail');
    requireValue(Number(processes.count) === 1, 'Mail must already be running');
    var process = processes.objectAtIndex(0);
    requireValue(!process.terminated, 'Mail must already be running');
    var pid = Number(process.processIdentifier);
    requireValue(integer(pid, 1, Number.MAX_SAFE_INTEGER), 'Invalid running Mail process');
    // A PID target cannot relaunch Mail if it exits between lookup and the Apple event.
    var mail = Application(pid);
    return JSON.stringify({ ok: true, result: dispatch(mail, request.operation, request.args) });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.safeMessage ? error.message :
      'Outcome unknown: Mail automation failed. Do not retry mutations automatically.' });
  }
}

if (typeof module !== 'undefined') module.exports = { dispatch: dispatch };
