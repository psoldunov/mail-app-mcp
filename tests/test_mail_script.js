'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { dispatch } = require('../src/mail_app_mcp/mail.js');
global.Automation = { getDisplayString: (value) => value.specifier };
global.$ = { NSThread: { sleepForTimeInterval() {} } };
let nextSpecifier = 0;
const BULK = ['subject', 'id', 'dateReceived', 'sender', 'messageId', 'readStatus', 'flaggedStatus'];

function collection(items) {
  const value = () => items.slice();
  Object.defineProperty(value, 'length', { get: () => items.length });
  items.forEach((item, index) => { value[index] = item; });
  value.whose = (criteria) => collection(items.filter((item) =>
    Object.keys(criteria).every((key) => typeof criteria[key] === 'object'
      ? item[key]().toLowerCase().includes(criteria[key]._contains.toLowerCase())
      : item[key]() === criteria[key])));
  value.slice = (start, end) => collection(items.slice(start, end + 1));
  BULK.forEach((key) => { value[key] = () => items.map((item) => item[key]()); });
  // A function's own `name` is read-only, so define the bulk getter instead of assigning it.
  Object.defineProperty(value, 'name', { value: () => items.map((item) => item.name()) });
  value.byId = (id) => items.find((item) => item.id() === id);
  value.push = (item) => { items.push(item); };
  return value;
}

function scripting(initial) {
  let state = initial;
  return Object.defineProperties({ specifier: `object:${nextSpecifier++}`, exists: () => true }, Object.fromEntries(Object.keys(initial).map((key) => [key, {
      get: () => () => state[key], set: (value) => { state = { ...state, [key]: value }; },
    }])));
}

function fixture(count = 1) {
  const account = scripting({ id: 'a1', name: 'Work', emailAddresses: ['me@example.com'] });
  const inbox = scripting({ name: 'Inbox', account, container: null, unreadCount: 1 });
  const archive = scripting({ name: 'Archive', account, container: null, unreadCount: 0 });
  const outbox = scripting({ name: 'Localized outgoing', account, container: null, unreadCount: 0 });
  const draftbox = scripting({ name: 'Localized drafts', account, container: null, unreadCount: 0 });
  const sentbox = scripting({ name: 'Localized sent', account, container: null, unreadCount: 0 });
  const messages = Array.from({ length: count }, (_, i) => Object.assign(scripting({
    id: i + 1, messageId: `<${i + 1}@example.com>`, mailbox: inbox,
    subject: i === 200 ? 'Needle' : 'Hello [literal]', sender: 'other@example.com',
    dateReceived: new Date('2026-01-02T03:04:05Z'), dateSent: new Date('2026-01-02T03:04:05Z'),
    readStatus: false, flaggedStatus: false, content: 'Body with secret', messageSize: 1000,
    allHeaders: 'To: me@example.com\nCc: Me Too <self@example.com>\n',
  }), { toRecipients: collection([scripting({ address: 'me@example.com' })]),
    ccRecipients: collection([]), mailAttachments: collection([]) }));
  for (const box of [inbox, archive, outbox, draftbox, sentbox]) {
    box.mailboxes = collection([]);
    box.messages = collection(box === inbox ? messages : []);
  }
  account.mailboxes = collection([inbox, archive, outbox, draftbox, sentbox]);
  const mail = { accounts: collection([account]), mailboxes: collection([]),
    outbox: () => outbox, draftsMailbox: () => draftbox, sentMailbox: () => sentbox };
  return { mail, account, inbox, archive, outbox, draftbox, sentbox, messages,
    ref: { account_id: 'a1', mailbox: ['Inbox'], message_id: 1, header_message_id: '<1@example.com>' } };
}

test('only fixed operations may touch Mail', () => {
  const mail = new Proxy({}, { get() { throw new Error('Mail was touched'); } });
  for (const operation of ['send', 'delete', 'quit', 'eval', 'constructor', '__proto__']) {
    assert.throws(() => dispatch(mail, operation, {}), /Unsupported operation/);
  }
});

test('lists public account fields plus the local account', () => {
  const mail = { accounts: () => [{ id: () => 'a1', name: () => 'Work',
    emailAddresses: () => ['me@example.com'] }] };
  assert.deepEqual(dispatch(mail, 'list_accounts', {}), { accounts: [
    { account_id: 'a1', name: 'Work', email_addresses: ['me@example.com'] },
    { account_id: '__local__', name: 'On My Mac', email_addresses: [] },
  ] });
});

test('lists and searches flat mailboxes with an account as their terminal container', () => {
  const { mail, account, inbox } = fixture();
  const terminal = { specifier: account.specifier,
    container: () => assert.fail('Account is not a mailbox') };
  const group = scripting({ name: '[Gmail]', account, container: terminal });
  inbox.container = group;
  account.mailboxes = collection([inbox]);
  assert.deepEqual(dispatch(mail, 'list_mailboxes', { account_id: 'a1' }),
    { mailboxes: [{ account_id: 'a1', path: ['[Gmail]', 'Inbox'], unread_count: 1 }] });
  const result = dispatch(mail, 'list_messages', { account_id: 'a1', mailbox: ['[Gmail]', 'Inbox'],
    offset: 0, limit: 20, query: 'hello', search_body: false });
  assert.equal(result.messages.length, 1);
  assert.deepEqual(result.messages[0].ref.mailbox, ['[Gmail]', 'Inbox']);
});

test('local mailbox paths end at a nonexistent account without hiding automation failures', () => {
  const { mail } = fixture();
  const terminal = { exists: () => false, name: () => assert.fail('Missing local account was read') };
  const parent = scripting({ name: 'Local', account: null, container: terminal });
  const child = scripting({ name: 'Archive', account: null, container: parent, unreadCount: 0 });
  mail.mailboxes = collection([child]);
  assert.deepEqual(dispatch(mail, 'list_mailboxes', { account_id: '__local__' }),
    { mailboxes: [{ account_id: '__local__', path: ['Local', 'Archive'], unread_count: 0 }] });
  parent.container = { exists: () => { throw new Error('Automation denied'); } };
  assert.throws(() => dispatch(mail, 'list_mailboxes', { account_id: '__local__' }), /Automation denied/);
});

test('list references keep the listed label mailbox, and both label and storage refs read the message', () => {
  const { mail, archive, messages } = fixture();
  messages[0].mailbox = archive;
  archive.messages = collection(messages);
  const args = { account_id: 'a1', mailbox: ['Inbox'], offset: 0, limit: 20,
    query: 'hello', search_body: false };
  const listed = dispatch(mail, 'list_messages', args).messages[0].ref;
  assert.deepEqual(listed.mailbox, ['Inbox']);
  assert.equal(dispatch(mail, 'read_message', { ref: listed, max_chars: 4 }).body, 'Body');
  assert.equal(dispatch(mail, 'read_message', { ref: { ...listed, mailbox: ['Archive'] }, max_chars: 4 }).body, 'Body');
  assert.throws(() => dispatch(mail, 'read_message', { ref: { ...listed, mailbox: ['Localized sent'] }, max_chars: 4 }),
    /missing/);
});

test('lists exact mailbox segment paths, including slashes, and rejects ambiguity', () => {
  const { mail, account, inbox } = fixture();
  const child = Object.assign(scripting({ name: 'A/B', account, container: inbox, unreadCount: 2 }),
    { mailboxes: collection([]), messages: collection([]) });
  inbox.mailboxes = collection([child]);
  account.mailboxes = collection([inbox, child]);
  const result = dispatch(mail, 'list_mailboxes', { account_id: 'a1' });
  assert.deepEqual(result.mailboxes[1], { account_id: 'a1', path: ['Inbox', 'A/B'], unread_count: 2 });
  account.mailboxes = collection([inbox, inbox]);
  assert.throws(() => dispatch(mail, 'list_messages', { account_id: 'a1', mailbox: ['Inbox'],
    offset: 0, limit: 10, query: '', search_body: false }), /ambiguous/i);
});

test('header search covers the whole mailbox in one call and says why a page stopped', () => {
  const { mail } = fixture(301);
  const args = { account_id: 'a1', mailbox: ['Inbox'], offset: 0, limit: 10,
    query: 'NEEDLE', search_body: false };
  const result = dispatch(mail, 'list_messages', args);
  assert.deepEqual(result.messages.map((m) => m.ref.message_id), [201]);
  assert.deepEqual({ ...result, messages: undefined },
    { messages: undefined, next_offset: null, complete: true, scanned: 301, stopped: 'end' });
  const page = dispatch(mail, 'list_messages', { ...args, query: '', limit: 2, offset: 299 });
  assert.deepEqual([page.next_offset, page.complete, page.stopped], [null, true, 'end']);
  const limited = dispatch(mail, 'list_messages', { ...args, query: '', limit: 2 });
  assert.deepEqual([limited.next_offset, limited.complete, limited.scanned, limited.stopped], [2, false, 2, 'limit']);
});

test('listing reads each header property once for the whole mailbox, never per message', () => {
  const { mail, inbox, messages } = fixture(50);
  inbox.messages = collection(messages.map((message) => new Proxy(message, { get(target, key) {
    if (key === 'content') assert.fail('Body was fetched');
    return target[key];
  } })));
  const calls = [];
  for (const key of BULK) {
    const bulk = inbox.messages[key];
    inbox.messages[key] = () => { calls.push(key); return bulk(); };
  }
  inbox.messages.slice = () => assert.fail('Range reads cost one Apple event per message');
  const result = dispatch(mail, 'list_messages', { account_id: 'a1', mailbox: ['Inbox'],
    offset: 0, limit: 20, query: 'hello', search_body: false });
  assert.equal(result.messages.length, 20);
  assert.deepEqual(calls.sort(), [...BULK, 'id'].sort());
  assert.deepEqual(Object.keys(result.messages[0]), ['ref', 'subject', 'sender', 'date_received', 'read', 'flagged']);
});

test('body search returns a resumable page when it exhausts the time budget', (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const { mail, inbox, messages } = fixture(3);
  inbox.messages = collection(messages.map((message) => slowBody(message, () => { now += 6000; })));
  const args = { account_id: 'a1', mailbox: ['Inbox'], offset: 0, limit: 20, query: 'absent', search_body: true };
  const result = dispatch(mail, 'list_messages', args);
  assert.deepEqual([result.scanned, result.next_offset, result.complete, result.stopped], [2, 2, false, 'time_budget']);
  const next = dispatch(mail, 'list_messages', { ...args, offset: result.next_offset });
  assert.deepEqual([next.scanned, next.next_offset, next.complete, next.stopped], [1, null, true, 'end']);
});

test('a slow snapshot still scans at least one message, so continuations always advance', (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const { mail, inbox, messages } = fixture(2);
  inbox.messages = collection(messages.map((message) => slowBody(message, () => { now += 60000; })));
  const ids = inbox.messages.id;
  inbox.messages.id = () => { now += 60000; return ids(); };
  const result = dispatch(mail, 'list_messages', { account_id: 'a1', mailbox: ['Inbox'],
    offset: 0, limit: 20, query: 'absent', search_body: true });
  assert.deepEqual([result.scanned, result.next_offset], [1, 1]);
});

function slowBody(message, tick) {
  return new Proxy(message, { get(target, key) {
    if (key === 'content') return () => { tick(); return 'no match'; };
    return target[key];
  } });
}

test('listing handles exhausted pages and rejects snapshots that change while reading', () => {
  const { mail, inbox, messages } = fixture(2);
  const args = { account_id: 'a1', mailbox: ['Inbox'], offset: 5, limit: 20, query: '', search_body: false };
  assert.deepEqual(dispatch(mail, 'list_messages', args),
    { messages: [], next_offset: null, complete: true, scanned: 0, stopped: 'end' });
  inbox.messages.sender = () => ['other@example.com'];
  assert.throws(() => dispatch(mail, 'list_messages', { ...args, offset: 0 }), /Mailbox changed/);
  inbox.messages = collection(messages);
  let reads = 0;
  inbox.messages.id = () => (++reads === 1 ? [1, 2] : [3, 1]);
  assert.throws(() => dispatch(mail, 'list_messages', { ...args, offset: 0 }), /Mailbox changed/);
  inbox.messages = collection(messages);
  inbox.messages.subject = () => [null, 'Hello'];
  assert.throws(() => dispatch(mail, 'list_messages', { ...args, offset: 0 }), /Mailbox changed/);
});

test('reads bounded body only after exact reference validation', () => {
  const { mail, ref, inbox, messages } = fixture();
  const result = dispatch(mail, 'read_message', { ref, max_chars: 4 });
  assert.equal(result.body, 'Body');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.to, ['me@example.com']);
  assert.match(result.headers, /^Cc: Me Too <self@example.com>$/m);
  assert.throws(() => dispatch(mail, 'read_message', {
    ref: { ...ref, header_message_id: '<stale>' }, max_chars: 4 }), /stale/i);
  inbox.messages = collection([]);
  assert.throws(() => dispatch(mail, 'read_message', { ref, max_chars: 4 }), /missing/i);
  assert.equal(messages[0].readStatus(), false);
});

test('a failing header getter keeps reads working with Mail recipients only', () => {
  for (const [number, works] of [[-10000, true], [-1743, false]]) {
    const { mail, ref, inbox, messages } = fixture();
    inbox.messages = collection([new Proxy(messages[0], { get(target, key) {
      if (key === 'allHeaders') return () => { throw Object.assign(new Error('Handler failed'), { errorNumber: number }); };
      return target[key];
    } })]);
    if (works) assert.equal(dispatch(mail, 'read_message', { ref, max_chars: 4 }).headers, '');
    else assert.throws(() => dispatch(mail, 'read_message', { ref, max_chars: 4 }), /Handler failed/);
  }
});

test('listed messages with an empty Message-ID can be read using their exact reference', () => {
  const { mail, messages } = fixture();
  messages[0].messageId = '';
  const listed = dispatch(mail, 'list_messages', { account_id: 'a1', mailbox: ['Inbox'],
    offset: 0, limit: 1, query: '', search_body: false });
  const ref = listed.messages[0].ref;
  assert.equal(ref.header_message_id, '');
  assert.equal(dispatch(mail, 'read_message', { ref, max_chars: 4 }).body, 'Body');
  messages[0].messageId = '<changed@example.com>';
  assert.throws(() => dispatch(mail, 'read_message', { ref, max_chars: 4 }), /stale/i);
  assert.throws(() => dispatch(mail, 'read_message', {
    ref: { ...ref, header_message_id: 'x'.repeat(2049) }, max_chars: 4 }), /Invalid reference/);
});

test('status updates verify identity and reject Outbox source before writing', () => {
  const { mail, ref, messages, outbox } = fixture();
  assert.deepEqual(dispatch(mail, 'set_message_status', { ref, read: true, flagged: true }),
    { ref, read: true, flagged: true });
  assert.throws(() => dispatch(mail, 'set_message_status', {
    ref: { ...ref, header_message_id: 'old' }, read: false, flagged: null }), /stale/i);
  assert.equal(messages[0].readStatus(), true);
  messages[0].mailbox = outbox;
  outbox.messages = collection(messages);
  assert.throws(() => dispatch(mail, 'set_message_status', {
    ref: { ...ref, mailbox: ['Localized outgoing'] }, read: false, flagged: null }), /unsafe|outbox/i);
  assert.equal(messages[0].readStatus(), true);
});

test('moves within account and rejects resolved special destinations and stale source', () => {
  const { mail, ref, inbox, messages } = fixture();
  for (const name of ['Localized outgoing', 'Localized drafts', 'Localized sent']) {
    assert.throws(() => dispatch(mail, 'move_message', { ref, destination: [name] }), /unsafe/i);
    assert.equal(messages[0].mailbox().name(), 'Inbox');
  }
  assert.deepEqual(dispatch(mail, 'move_message', { ref, destination: ['Archive'] }),
    { account_id: 'a1', destination: ['Archive'], moved: true });
  assert.equal(messages[0].mailbox().name(), 'Archive');
  inbox.messages = collection([]);
  assert.throws(() => dispatch(mail, 'move_message', { ref, destination: ['Inbox'] }), /missing/i);
});

test('attachment saves reject absent, unavailable and oversize attachments before saving', () => {
  const { mail, ref, messages } = fixture();
  let saves = [];
  const attachment = scripting({ id: 'att1', name: '../report.pdf', mimeType: 'application/pdf',
    fileSize: 12, downloaded: false });
  messages[0].mailAttachments = collection([attachment]);
  mail.save = (item, options) => { saves = saves.concat([{ item, options }]); };
  global.Path = (path) => path;
  const args = { ref, attachment_id: 'att1', path: '/private/safe/random.pdf', max_bytes: 10 };
  assert.throws(() => dispatch(mail, 'save_attachment', args), /download/i);
  attachment.downloaded = true;
  assert.throws(() => dispatch(mail, 'save_attachment', args), /size/i);
  assert.throws(() => dispatch(mail, 'save_attachment', { ...args, attachment_id: 'absent' }), /missing/i);
  assert.equal(saves.length, 0);
  assert.deepEqual(dispatch(mail, 'save_attachment', { ...args, max_bytes: 20 }),
    { name: '../report.pdf', mime_type: 'application/pdf', size: 12 });
  assert.equal(saves.length, 1);
  assert.equal(saves[0].item, attachment);
  assert.deepEqual(saves[0].options, { in: '/private/safe/random.pdf' });
  delete global.Path;
});

// Saving an outgoing message makes Mail write a copy, with its signature, into Drafts. Saving the same
// outgoing message again replaces that copy under a new ID, as Mail does.
function composing(mail, { copy = true } = {}) {
  const saved = [];
  const drafts = [];
  const draftbox = mail.draftsMailbox();
  const copies = new Map();
  let nextId = 900;
  mail.outgoingMessages = collection(drafts);
  mail.OutgoingMessage = (properties) => Object.assign(scripting({ id: 42, subject: '', visible: true, ...properties }), {
    toRecipients: collection([]), ccRecipients: collection([]), bccRecipients: collection([]),
  });
  mail.ToRecipient = mail.CcRecipient = mail.BccRecipient = (properties) => scripting(properties);
  mail.save = (draft) => {
    if (!saved.includes(draft)) saved.push(draft);
    if (!copy) return;
    nextId += 1;
    const previous = copies.get(draft);
    copies.set(draft, nextId);
    draftbox.messages = collection(draftbox.messages().filter((message) => message.id() !== previous)
      .concat([scripting({ id: nextId, messageId: `<draft-${nextId}@example.com>`, mailbox: draftbox,
        subject: draft.subject(), content: `\n${draft.content()} \n\n--\nSignature` })]));
  };
  mail.send = () => assert.fail('must never send');
  mail.activate = () => assert.fail('must not activate without an explicit window request');
  mail.open = () => assert.fail('must not open a window without an explicit request');
  return { saved, drafts, savedRef: (id) => ({ account_id: 'a1', mailbox: ['Localized drafts'], message_id: id,
    header_message_id: `<draft-${id}@example.com>` }) };
}

test('unavailable MIME metadata preserves message reads and bounded attachment export with a warning', () => {
  const { mail, ref, messages } = fixture();
  const attachment = { id: () => 'att1', name: () => 'signature.png',
    mimeType: () => { throw Object.assign(new Error('AppleEvent handler failed.'), { errorNumber: -10000 }); },
    fileSize: () => 12, downloaded: () => true };
  messages[0].mailAttachments = collection([attachment]);
  const read = dispatch(mail, 'read_message', { ref, max_chars: 4 });
  assert.equal(read.body, 'Body');
  assert.equal(read.attachments[0].mime_type, 'application/octet-stream');
  assert.match(read.attachments[0].warning, /MIME.*unavailable.*-10000/);
  global.Path = (path) => path;
  let saves = 0;
  mail.save = () => { saves += 1; };
  try {
    const exported = dispatch(mail, 'save_attachment', { ref, attachment_id: 'att1', path: '/private/test', max_bytes: 20 });
    assert.equal(exported.mime_type, 'application/octet-stream');
    assert.equal(exported.warning, read.attachments[0].warning);
    assert.equal(saves, 1);
  } finally { delete global.Path; }
  for (const number of [-1743, -1728]) {
    messages[0].mailAttachments = collection([{ ...attachment,
      mimeType: () => { throw Object.assign(new Error('Denied or stale'), { errorNumber: number }); } }]);
    assert.throws(() => dispatch(mail, 'read_message', { ref, max_chars: 4 }), /Denied or stale/);
  }
});

test('show_draft is gone: saved drafts are shown by their ref through show_message', () => {
  const mail = new Proxy({}, { get() { assert.fail('Mail was touched'); } });
  assert.throws(() => dispatch(mail, 'show_draft', { account_id: 'a1', draft_id: 0, sender: 'me@example.com' }),
    /Unsupported operation/);
});

test('creates and saves only a draft using an explicit account sender, and returns its saved copy', () => {
  const { mail } = fixture();
  const { saved, drafts, savedRef } = composing(mail);
  const args = { account_id: 'a1', sender: 'me@example.com', to: ['you@example.com'],
    cc: ['cc@example.com'], bcc: ['bcc@example.com'], subject: 'Subject', body: '<literal text>\nsecond  line' };
  assert.throws(() => dispatch(mail, 'create_draft', { ...args, sender: 'imposter@example.com' }), /sender/i);
  assert.throws(() => dispatch(mail, 'create_draft', { ...args, account_id: '__local__' }), /local/i);
  assert.equal(drafts.length, 0);
  assert.deepEqual(dispatch(mail, 'create_draft', args),
    { status: 'draft', account_id: 'a1', sender: 'me@example.com', ref: savedRef(902) });
  assert.equal(saved.length, 1);
  assert.equal(saved[0], drafts[0]);
  assert.equal(saved[0].content(), '<literal text>\nsecond  line');
  assert.equal(saved[0].visible(), false);
  assert.equal(saved[0].bccRecipients()[0].address(), 'bcc@example.com');
});

test('a saved copy that is slow to appear is a warned success, not an uncertain write', (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => (now += 1000));
  const { mail } = fixture();
  const { saved } = composing(mail, { copy: false });
  const result = dispatch(mail, 'create_draft', { account_id: 'a1', sender: 'me@example.com', to: ['you@example.com'],
    cc: [], bcc: [], subject: 'Slow', body: 'Body', open_window: true });
  assert.equal(saved.length, 1);
  assert.equal(result.ref, null);
  assert.match(result.warning, /did not appear.*no window was opened.*Do not retry/);
});

test('a saved draft that Mail cannot open is a warned success, not an uncertain write', () => {
  const { mail, ref } = fixture();
  const { savedRef } = composing(mail);
  mail.open = () => { throw Object.assign(new Error("Can't get object."), { errorNumber: -1728 }); };
  mail.activate = () => assert.fail('Mail must not come forward when nothing opened');
  mail.reply = () => mail.OutgoingMessage({ subject: 'Re: Hello', content: '', sender: 'me@example.com' });
  const result = dispatch(mail, 'reply_draft', { ref, sender: 'me@example.com', body: 'Reply', reply_all: true,
    open_window: true });
  assert.deepEqual(result.ref, savedRef(902));
  assert.match(result.warning, /could not open it: Can't get object.*show_message/);
});

test('a copy Mail deletes while it is being checked is skipped, not reported as a failure', () => {
  const { mail, draftbox } = fixture();
  const { savedRef } = composing(mail);
  const save = mail.save;
  mail.save = (draft) => {
    save(draft);
    const vanished = new Proxy(scripting({ id: 950 }), { get(target, key) {
      if (key === 'id') return target.id;
      return () => { throw Object.assign(new Error("Can't get object."), { errorNumber: -1728 }); };
    } });
    draftbox.messages = collection(draftbox.messages().concat([vanished]));
  };
  const result = dispatch(mail, 'create_draft', { account_id: 'a1', sender: 'me@example.com', to: ['you@example.com'],
    cc: [], bcc: [], subject: 'Race', body: 'Body' });
  assert.deepEqual(result.ref, savedRef(902));
  assert.equal(result.warning, undefined);
});

test('a draft is saved again once its first copy appears, so Mail has nothing left to re-save later', () => {
  const { mail, draftbox } = fixture();
  const { savedRef } = composing(mail);
  const save = mail.save;
  const copiesAtSave = [];
  mail.save = (draft) => { copiesAtSave.push(draftbox.messages().length); save(draft); };
  const result = dispatch(mail, 'create_draft', { account_id: 'a1', sender: 'me@example.com', to: ['you@example.com'],
    cc: [], bcc: [], subject: 'Twice', body: 'Body' });
  assert.deepEqual(copiesAtSave, [0, 1]);
  assert.deepEqual(result.ref, savedRef(902));
  assert.equal(draftbox.messages().length, 1);
});

test('a slow second save never returns the first copy that it is about to replace', () => {
  const { mail, draftbox } = fixture();
  const { savedRef } = composing(mail);
  const save = mail.save;
  let saves = 0;
  mail.save = (draft) => {
    if (++saves < 2) { save(draft); return; }
    const [first] = draftbox.messages();
    const second = scripting({ id: 905, messageId: '<draft-905@example.com>', mailbox: draftbox,
      subject: first.subject(), content: first.content() });
    let reads = 0;
    // Mail keeps the first copy for more polls than the settle count before writing the second one.
    Object.defineProperty(draftbox, 'messages', { configurable: true,
      get: () => collection(++reads > 16 ? [second] : [first]) });
  };
  const result = dispatch(mail, 'create_draft', { account_id: 'a1', sender: 'me@example.com', to: ['you@example.com'],
    cc: [], bcc: [], subject: 'Slow', body: 'Body' });
  assert.deepEqual(result.ref, savedRef(905));
});

test('if the second save writes no newer copy in time, the first copy is still returned', (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => (now += 500));
  const { mail } = fixture();
  const { savedRef } = composing(mail);
  const save = mail.save;
  let saves = 0;
  mail.save = (draft) => { if (++saves < 2) save(draft); };
  const result = dispatch(mail, 'create_draft', { account_id: 'a1', sender: 'me@example.com', to: ['you@example.com'],
    cc: [], bcc: [], subject: 'Noop', body: 'Body' });
  assert.deepEqual(result.ref, savedRef(901));
  assert.equal(result.warning, undefined);
});

test('a copy that Mail replaces right after the second save is followed to the newest one', () => {
  const { mail, draftbox } = fixture();
  const { savedRef } = composing(mail);
  const save = mail.save;
  let saves = 0;
  mail.save = (draft) => {
    save(draft);
    if (++saves < 2) return;
    const [first] = draftbox.messages();
    const second = scripting({ id: 903, messageId: '<draft-903@example.com>', mailbox: draftbox,
      subject: first.subject(), content: first.content() });
    const before = collection([first]);
    const after = collection([second]);
    let reads = 0;
    // Each poll reads the Drafts collection twice; Mail swaps the copy after three polls.
    Object.defineProperty(draftbox, 'messages', { configurable: true, get: () => (++reads > 6 ? after : before) });
  };
  const result = dispatch(mail, 'create_draft', { account_id: 'a1', sender: 'me@example.com', to: ['you@example.com'],
    cc: [], bcc: [], subject: 'Settle', body: 'Body' });
  assert.deepEqual(result.ref, savedRef(903));
});

test('a saved copy without the requested body reports an unknown outcome', (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => (now += 1000));
  const { mail, draftbox } = fixture();
  composing(mail);
  const save = mail.save;
  mail.save = (draft) => { save(draft); draftbox.messages()[0].content = '\n--\nSignature only'; };
  assert.throws(() => dispatch(mail, 'create_draft', { account_id: 'a1', sender: 'me@example.com', to: ['you@example.com'],
    cc: [], bcc: [], subject: 'Lost', body: 'Body' }), /^Error: Outcome unknown:.*without the requested body/);
});

test('expired references explain rediscovery after draft autosave without reading another message', () => {
  const { mail, ref, messages } = fixture();
  const args = { ref, max_chars: 100 };
  assert.throws(() => dispatch(mail, 'read_message', {
    ...args, ref: { ...ref, message_id: 99 },
  }), /Message missing or ambiguous.*list_messages.*autosave/);
  messages[0].messageId = 'autosaved@example.com';
  assert.throws(() => dispatch(mail, 'read_message', args), /stale.*list_messages.*autosave/);
});

test('reply rejects saved drafts, including canonical All Mail references, before mutation', () => {
  for (const canonical of [false, true]) {
    const { mail, draftbox, archive, messages, ref } = fixture();
    const { saved } = composing(mail);
    const box = canonical ? archive : draftbox;
    messages[0].mailbox = box;
    box.messages = collection(messages);
    draftbox.messages = collection(messages);
    mail.reply = () => assert.fail('Native reply must not run for a saved draft');
    const source = { ...ref, mailbox: [box.name()] };
    assert.throws(() => dispatch(mail, 'reply_draft', {
      ref: source, sender: 'me@example.com', body: 'Reply', reply_all: true,
    }), /^Error: Cannot reply to a saved draft.*received message/);
    assert.equal(saved.length, 0);
  }
});

test('native reply hides its window before writing the body, quotes the original and saves without sending', () => {
  const { mail, ref, messages } = fixture();
  const { saved, savedRef } = composing(mail);
  messages[0].content = 'Line one\nLine two ￼';
  const events = [];
  let replies = 0;
  mail.reply = (message, options) => {
    assert.equal(message, messages[0]);
    assert.deepEqual(options, { openingWindow: false, replyToAll: true });
    replies += 1;
    // Mail opens a visible window anyway; its view would autosave over scripted content.
    const draft = mail.OutgoingMessage({ subject: 'Re: Hello', content: '', sender: 'wrong@example.com' });
    return new Proxy(draft, { set(target, key, value) {
      events.push([key, key === 'content' ? 'body' : value]);
      target[key] = value;
      return true;
    } });
  };
  const args = { ref, sender: 'me@example.com', body: 'My reply', reply_all: true };
  assert.throws(() => dispatch(mail, 'reply_draft', { ...args, sender: 'wrong@example.com' }), /sender/i);
  assert.equal(replies, 0);
  assert.deepEqual(dispatch(mail, 'reply_draft', args),
    { status: 'draft', account_id: 'a1', sender: 'me@example.com', ref: savedRef(902) });
  assert.deepEqual(events, [['visible', false], ['sender', 'me@example.com'], ['content', 'body']]);
  assert.match(saved[0].content(), /^My reply\n\nOn .+, other@example.com wrote:\n\n> Line one\n> Line two $/);
});

test('reply quotes are bounded for very long originals', () => {
  const { mail, ref, messages } = fixture();
  const { saved } = composing(mail);
  messages[0].content = 'x'.repeat(100001);
  mail.reply = () => mail.OutgoingMessage({ subject: 'Re: Hello', content: '', sender: 'me@example.com' });
  dispatch(mail, 'reply_draft', { ref, sender: 'me@example.com', body: 'Short', reply_all: false });
  assert.match(saved[0].content(), /^Short\n\nOn .+ wrote:\n\n> x{100000}\n> \[…\]$/);
});

test('draft membership is account-scoped and a failed lookup cannot create a reply', () => {
  const { mail, ref, draftbox } = fixture();
  const { saved } = composing(mail);
  const otherAccount = scripting({ id: 'a2' });
  const otherBox = scripting({ name: 'Drafts', account: otherAccount, container: null });
  draftbox.messages = collection([scripting({ id: ref.message_id, mailbox: otherBox })]);
  mail.reply = () => mail.OutgoingMessage({ content: 'Quote', sender: 'me@example.com' });
  const args = { ref, sender: 'me@example.com', body: 'Reply', reply_all: false };
  assert.equal(dispatch(mail, 'reply_draft', args).status, 'draft');
  assert.equal(saved.length, 1);
  mail.draftsMailbox = () => { throw new Error('Drafts unavailable'); };
  assert.throws(() => dispatch(mail, 'reply_draft', args), /^Error: Drafts unavailable$/);
  assert.equal(saved.length, 1);
});

function runtime(request, processes, application, options = {}) {
  let now = 0;
  const context = vm.createContext({
    ObjC: { import() {}, unwrap: (value) => value },
    Ref: () => [],
    Date: { now: () => now },
    $: { NSUTF8StringEncoding: 4,
      NSFileHandle: { fileHandleWithStandardInput: { readDataToEndOfFile: JSON.stringify(request) } },
      NSString: { alloc: { initWithDataEncoding: (data) => data } },
      NSDictionary: { dictionary: {} },
      NSWorkspaceLaunchWithoutActivation: 512,
      NSWorkspaceLaunchAndHide: 1048576,
      NSWorkspace: { sharedWorkspace: {
        URLForApplicationWithBundleIdentifier: (id) => {
          assert.equal(id, 'com.apple.mail');
          return 'file:///System/Applications/Mail.app';
        },
        launchApplicationAtURLOptionsConfigurationError: options.launch || (() => assert.fail('Must not launch Mail')),
      } },
      NSThread: { sleepForTimeInterval: (seconds) => { now += seconds * 1000; } },
      NSRunningApplication: { runningApplicationsWithBundleIdentifier: (id) => {
        assert.equal(id, 'com.apple.mail');
        const current = typeof processes === 'function' ? processes() : processes;
        return { count: current.length, objectAtIndex: (index) => current[index] };
      } },
    },
    Application: application,
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/mail_app_mcp/mail.js'), 'utf8'), context);
  return JSON.parse(context.run());
}

test('stdin entrypoint targets a running PID and returns only a JSON envelope', () => {
  const { mail } = fixture();
  const result = runtime({ operation: 'list_accounts', args: {} },
    [{ processIdentifier: 123, terminated: false }], (pid) => {
      assert.equal(pid, 123);
      return mail;
    });
  assert.equal(result.ok, true);
  assert.equal(result.result.accounts[0].account_id, 'a1');
});

test('stdin entrypoint never launches or resolves an application for rejected requests', () => {
  const forbidden = () => assert.fail('Application must not be resolved');
  assert.match(runtime({ operation: 'send', args: {} }, [], forbidden).error, /Unsupported/);
  assert.match(runtime({ operation: 'list_mailboxes', args: {} }, [], forbidden).error, /Invalid account/);
  assert.match(runtime({ operation: 'list_accounts', args: {} },
    [{ processIdentifier: 123, terminated: true }], forbidden).error, /running/i);
});

test('stdin entrypoint launches stopped Mail hidden without activation and waits for its PID', () => {
  const { mail } = fixture();
  let launches = 0;
  let polls = 0;
  const processes = () => ++polls < 3 ? [] : [{ processIdentifier: 456, terminated: false }];
  const result = runtime({ operation: 'list_accounts', args: {} }, processes, (pid) => {
    assert.equal(pid, 456);
    return mail;
  }, { launch(url, options) {
    assert.equal(url, 'file:///System/Applications/Mail.app');
    assert.equal(options, 512 | 1048576);
    launches += 1;
    return {};
  } });
  assert.equal(result.ok, true);
  assert.equal(launches, 1);
  assert.equal(polls, 3);
});

test('stdin entrypoint waits for a valid running PID after hidden launch', () => {
  const { mail } = fixture();
  let polls = 0;
  const result = runtime({ operation: 'list_accounts', args: {} }, () => {
    polls += 1;
    return polls === 1 ? [] : [{ processIdentifier: polls < 4 ? 0 : 456, terminated: false }];
  }, (pid) => {
    assert.equal(pid, 456);
    return mail;
  }, { launch: () => ({}) });
  assert.equal(result.ok, true);
  assert.equal(polls, 4);
});

test('stdin entrypoint bounds startup waiting and reports launch failures before using Mail', () => {
  const forbidden = () => assert.fail('Application must not be resolved');
  let polls = 0;
  let launches = 0;
  const timedOut = runtime({ operation: 'list_accounts', args: {} }, () => {
    polls += 1;
    return [];
  }, forbidden, { launch() { launches += 1; return {}; } });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error, /Mail did not start/);
  assert.equal(launches, 1);
  assert.ok(polls > 1 && polls <= 52);
  const failed = runtime({ operation: 'list_accounts', args: {} }, [], forbidden, {
    launch(url, options, configuration, error) {
      error[0] = { localizedDescription: 'Launch Services denied request' };
      return null;
    },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Could not launch Mail hidden: Launch Services denied request/);
  assert.doesNotMatch(failed.error, /Outcome unknown/);
});

test('read failures expose the automation cause without an unknown write outcome', () => {
  const result = runtime({ operation: 'list_accounts', args: {} },
    [{ processIdentifier: 123, terminated: false }], () => { throw Object.assign(new Error('Not authorized to send Apple events'), { errorNumber: -1743 }); });
  assert.equal(result.ok, false);
  assert.match(result.error, /Not authorized/);
  assert.doesNotMatch(result.error, /Outcome unknown/);
  assert.equal(result.operation, 'list_accounts');
  assert.equal(result.apple_script_error_number, -1743);
});

test('every failure from the first draft, status or move event reports an unknown outcome', () => {
  const { mail, ref, messages } = fixture();
  composing(mail);
  mail.save = () => { throw new Error('private Mail internals'); };
  assert.throws(() => dispatch(mail, 'create_draft', { account_id: 'a1', sender: 'me@example.com',
    to: ['you@example.com'], cc: [], bcc: [], subject: '', body: '' }), /^Error: Outcome unknown:/);
  mail.reply = () => { throw new Error('private Mail internals'); };
  assert.throws(() => dispatch(mail, 'reply_draft', { ref, sender: 'me@example.com',
    body: '', reply_all: false }), /^Error: Outcome unknown:/);
  const original = messages[0];
  const faulty = new Proxy(original, { set() { throw new Error('private Mail internals'); } });
  original.mailbox().messages = collection([faulty]);
  assert.throws(() => dispatch(mail, 'set_message_status', { ref, read: true, flagged: null }),
    /^Error: Outcome unknown:/);
  assert.throws(() => dispatch(mail, 'move_message', { ref, destination: ['Archive'] }),
    /^Error: Outcome unknown:/);
});

test('invalid requests fail before accessing Mail', () => {
  const mail = new Proxy({}, { get() { assert.fail('Mail was touched'); } });
  const { ref } = fixture();
  for (const [operation, args] of [
    ['list_messages', { account_id: 'a1', mailbox: ['Inbox'], offset: -1, limit: 1, query: '', search_body: false }],
    ['read_message', { ref, max_chars: 100001 }],
    ['move_message', { ref, destination: [] }],
    ['set_message_status', { ref, read: null, flagged: null }],
    ['set_message_status', { ref, read: 'true' }],
    ['save_attachment', { ref, attachment_id: 'a', path: '../escape', max_bytes: 1 }],
    ['reply_draft', { ref, sender: 'me@example.com', body: '', reply_all: 1 }],
    ['read_message', { ref: { ...ref, message_id: 0 }, max_chars: 1 }],
  ]) assert.throws(() => dispatch(mail, operation, args), /Invalid/);
});

test('literal search does not touch message content unless requested', () => {
  const { mail, inbox, messages } = fixture();
  inbox.messages = collection([new Proxy(messages[0], { get(target, key) {
    if (key === 'content') assert.fail('Body was fetched');
    return target[key];
  } })]);
  const args = { account_id: 'a1', mailbox: ['Inbox'], offset: 0, limit: 1, query: '[literal]', search_body: false };
  assert.equal(dispatch(mail, 'list_messages', args).messages.length, 1);
  assert.equal(dispatch(mail, 'list_messages', { ...args, query: 'secret' }).messages.length, 0);
  inbox.messages = collection(messages);
  assert.equal(dispatch(mail, 'list_messages', { ...args, query: 'secret', search_body: true }).messages.length, 1);
});

test('local discovery excludes remote boxes and hierarchy traversal is bounded', () => {
  const { mail, inbox } = fixture();
  const local = Object.assign(scripting({ name: 'Local', account: null, container: null, unreadCount: 0 }),
    { mailboxes: collection([]) });
  mail.mailboxes = collection([inbox, local]);
  assert.deepEqual(dispatch(mail, 'list_mailboxes', { account_id: '__local__' }),
    { mailboxes: [{ account_id: '__local__', path: ['Local'], unread_count: 0 }] });
  mail.mailboxes = collection(Array(1001).fill(local));
  assert.throws(() => dispatch(mail, 'list_mailboxes', { account_id: '__local__' }), /too large/);
  local.container = local;
  mail.mailboxes = collection([local]);
  assert.throws(() => dispatch(mail, 'list_mailboxes', { account_id: '__local__' }), /too deep/);
});

test('missing and ambiguous message identities cannot be mutated', () => {
  const { mail, ref, inbox, messages } = fixture();
  inbox.messages = collection([]);
  assert.throws(() => dispatch(mail, 'set_message_status', { ref, read: true }), /missing/);
  inbox.messages = collection([messages[0], messages[0]]);
  assert.throws(() => dispatch(mail, 'set_message_status', { ref, read: true }), /ambiguous/);
  assert.equal(messages[0].readStatus(), false);
});

test('special descendants and known sending names cannot be move destinations', () => {
  const { mail, ref, account, outbox } = fixture();
  const child = Object.assign(scripting({ name: 'Queue', account, container: outbox, unreadCount: 0 }),
    { mailboxes: collection([]) });
  outbox.mailboxes = collection([child]);
  account.mailboxes = collection(account.mailboxes().concat([child]));
  assert.throws(() => dispatch(mail, 'move_message', { ref, destination: ['Localized outgoing', 'Queue'] }), /Unsafe/);
  const later = Object.assign(scripting({ name: 'Send Later', account, container: null, unreadCount: 0 }),
    { mailboxes: collection([]) });
  account.mailboxes = collection(account.mailboxes().concat([later]));
  assert.throws(() => dispatch(mail, 'move_message', { ref, destination: ['Send Later'] }), /Unsafe/);
});

test('ambiguous sender accounts cannot create a draft under an assumed identity', () => {
  const { mail, account } = fixture();
  const { drafts } = composing(mail);
  const other = scripting({ id: 'a2', name: 'Other', emailAddresses: ['me@example.com'] });
  mail.accounts = collection([account, other]);
  assert.throws(() => dispatch(mail, 'create_draft', { account_id: 'a1', sender: 'me@example.com',
    to: ['you@example.com'], cc: [], bcc: [], subject: '', body: '' }), /ambiguous/i);
  assert.equal(drafts.length, 0);
});

test('oversized or unknown message sizes cannot fetch bodies or create reply quotes', () => {
  for (const size of [20 * 1024 * 1024 + 1, undefined, NaN, -1]) {
    const { mail, ref, inbox, messages } = fixture();
    messages[0].messageSize = size;
    inbox.messages = collection([new Proxy(messages[0], { get(target, key) {
      if (key === 'content') assert.fail('Oversized body was fetched');
      return target[key];
    } })]);
    mail.reply = () => assert.fail('Oversized reply was created');
    assert.throws(() => dispatch(mail, 'read_message', { ref, max_chars: 10 }), /size.*headers|headers.*size/i);
    assert.throws(() => dispatch(mail, 'list_messages', { account_id: 'a1', mailbox: ['Inbox'],
      offset: 0, limit: 1, query: 'unmatched', search_body: true }), /size.*headers|headers.*size/i);
    assert.throws(() => dispatch(mail, 'reply_draft', { ref, sender: 'me@example.com',
      body: 'reply', reply_all: false }), /size.*headers|headers.*size/i);
    assert.equal(dispatch(mail, 'list_messages', { account_id: 'a1', mailbox: ['Inbox'],
      offset: 0, limit: 1, query: '', search_body: false }).messages.length, 1);
  }
});

test('explicit create and reply windows open the saved copy, since hidden compose windows cannot be reshown', () => {
  const { mail, ref, draftbox } = fixture();
  const { saved } = composing(mail);
  const events = [];
  mail.open = (message) => events.push(['open', message.id(), saved.length]);
  mail.activate = () => events.push(['activate']);
  dispatch(mail, 'create_draft', { account_id: 'a1', sender: 'me@example.com',
    to: ['you@example.com'], cc: [], bcc: [], subject: '', body: '', open_window: true });
  mail.reply = () => mail.OutgoingMessage({ sender: 'me@example.com', content: 'original' });
  dispatch(mail, 'reply_draft', { ref, sender: 'me@example.com', body: 'reply', reply_all: false, open_window: true });
  assert.deepEqual(events, [['open', 902, 1], ['activate'], ['open', 904, 2], ['activate']]);
  assert.deepEqual(saved.map((draft) => draft.visible()), [false, false]);
  assert.equal(draftbox.messages().length, 2);
});

test('show_message opens only the resolved message and rejects stale references', () => {
  const { mail, ref, messages } = fixture();
  const events = [];
  mail.open = (message) => { assert.equal(message, messages[0]); events.push('open'); };
  mail.activate = () => events.push('activate');
  assert.throws(() => dispatch(mail, 'show_message', { ref: { ...ref, header_message_id: 'old' } }), /stale/);
  assert.deepEqual(events, []);
  assert.deepEqual(dispatch(mail, 'show_message', { ref }), { shown: true });
  assert.deepEqual(events, ['open', 'activate']);
});

test('global sender search orders all accounts before applying the limit', () => {
  const first = fixture(2);
  const second = fixture();
  second.account.id = 'a2';
  first.messages[0].sender = 'Isabel <isabel@example.com>';
  first.messages[1].sender = 'Someone else';
  second.messages[0].sender = 'Isabel <isabel@example.com>';
  second.messages[0].dateReceived = new Date('2026-11-12T00:00:00Z');
  const mail = { ...first.mail, accounts: collection([first.account, second.account]) };
  const result = dispatch(mail, 'search_messages', { from: 'isabel', sort: 'newest', limit: 1,
    account_id: null, mailbox: null });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].ref.account_id, 'a2');
  assert.equal(result.complete, true);
  assert.equal(result.has_more, true);
});

test('search scopes, local mail, duplicate labels and oldest ordering', () => {
  const { mail, inbox, archive, messages } = fixture(2);
  messages[0].dateReceived = new Date('2026-10-01T00:00:00Z');
  archive.messages = collection([messages[0]]);
  const local = scripting({ name: 'Local', account: null, container: null });
  const localMessage = scripting({ id: 30, messageId: '<local>', mailbox: local, subject: 'local',
    sender: 'other@example.com', dateReceived: new Date('2026-11-01T00:00:00Z'), readStatus: false, flaggedStatus: false });
  local.messages = collection([localMessage]);
  mail.mailboxes = collection([local, inbox]);
  const args = { from: '', sort: 'newest', limit: 10, account_id: null, mailbox: null };
  const result = dispatch(mail, 'search_messages', args);
  assert.deepEqual(result.messages.map((m) => m.ref.message_id), [30, 1, 2]);
  assert.equal(result.has_more, false);
  assert.deepEqual(dispatch(mail, 'search_messages', { ...args, sort: 'oldest' }).messages.map((m) => m.ref.message_id), [2, 1, 30]);
  assert.equal(dispatch(mail, 'search_messages', { ...args, account_id: '__local__' }).messages.length, 1);
  assert.equal(dispatch(mail, 'search_messages', { ...args, account_id: 'a1', mailbox: ['Archive'] }).messages.length, 1);
  assert.equal(dispatch(mail, 'search_messages', { ...args, from: 'absent' }).messages.length, 0);
  assert.throws(() => dispatch(mail, 'search_messages', { ...args, account_id: 'missing' }), /Account/);
});

test('global search bounds work and rejects incomplete or changing metadata', () => {
  const args = { from: '', sort: 'newest', limit: 1, account_id: 'a1', mailbox: null };
  const { mail, inbox, messages } = fixture();
  messages[0].dateReceived = new Date('invalid');
  assert.throws(() => dispatch(mail, 'search_messages', args), /received date/);
  messages[0].dateReceived = new Date('2026-01-01');
  inbox.messages.dateReceived = () => [];
  assert.throws(() => dispatch(mail, 'search_messages', args), /Mailbox changed/);
  inbox.messages = collection(messages);
  let reads = 0;
  inbox.messages.id = () => ++reads === 1 ? [1] : [2];
  assert.throws(() => dispatch(mail, 'search_messages', args), /Mailbox changed/);
  const many = Array.from({ length: 20001 }, (_, index) => index + 1);
  inbox.messages = { id: () => many, dateReceived: () => many.map(() => new Date('2026-01-01')) };
  assert.throws(() => dispatch(mail, 'search_messages', args), /20000/);
  for (const bad of [{ sort: 'random' }, { limit: 101 }, { from: 4 }, { account_id: null, mailbox: ['Inbox'] }]) {
    assert.throws(() => dispatch({}, 'search_messages', { ...args, ...bad }), /Invalid/);
  }
});

test('global search never returns partial latest when an account fails or time expires', (t) => {
  const { mail, account } = fixture();
  const args = { from: '', sort: 'newest', limit: 1, account_id: null, mailbox: null };
  const broken = { id: () => 'a2', mailboxes: () => { throw new Error('Account unavailable'); } };
  mail.accounts = collection([account, broken]);
  assert.throws(() => dispatch(mail, 'search_messages', args), /Account unavailable/);
  mail.accounts = collection([account]);
  let time = 0;
  t.mock.method(Date, 'now', () => time);
  mail.mailboxes = () => { time = 35001; return []; };
  assert.throws(() => dispatch(mail, 'search_messages', args), /latest match not established/);
});

test('sender filter reads whole-mailbox headers and hydrates only selected summaries', () => {
  const { mail, inbox, messages } = fixture(1000);
  messages[999].sender = 'Isabel <isabel@example.com>';
  inbox.messages = collection(messages.map((message, index) => new Proxy(message, { get(target, key) {
    if (key === 'content' || (index !== 999 && key === 'subject')) assert.fail('Nonmatch body or summary fetched');
    return target[key];
  } })));
  inbox.messages.whose = () => assert.fail('A whose clause rescans the mailbox for every property read');
  inbox.messages.subject = () => assert.fail('Filtering needs no subjects');
  const result = dispatch(mail, 'search_messages', { from: 'isabel', sort: 'newest', limit: 1,
    account_id: 'a1', mailbox: null });
  assert.equal(result.matched_candidates, 1);
  assert.equal(result.messages[0].ref.message_id, 1000);
  assert.ok(result.timing_ms.total >= 0);
});

test('an empty mailbox that rejects bulk reads counts as empty; a nonempty one still fails', () => {
  const { mail, archive } = fixture();
  const notes = (length) => ({ length, id: () => { throw Object.assign(new Error("Can't get object."), { errorNumber: -1728 }); } });
  archive.messages = notes(0);
  assert.equal(dispatch(mail, 'search_messages', { from: '', sort: 'newest', limit: 5, account_id: 'a1', mailbox: null })
    .messages.length, 1);
  assert.deepEqual(dispatch(mail, 'list_messages', { account_id: 'a1', mailbox: ['Archive'], offset: 0, limit: 5,
    query: '', search_body: false }), { messages: [], next_offset: null, complete: true, scanned: 0, stopped: 'end' });
  archive.messages = notes(3);
  assert.throws(() => dispatch(mail, 'search_messages', { from: '', sort: 'newest', limit: 5, account_id: 'a1',
    mailbox: null }), /Can't get object/);
});

test('a received-time tie puts the higher Mail ID first for newest and last for oldest', () => {
  const { mail } = fixture(2);
  const ids = (sort) => dispatch(mail, 'search_messages', { from: '', sort, limit: 5, account_id: 'a1', mailbox: null })
    .messages.map((message) => message.ref.message_id);
  assert.deepEqual(ids('newest'), [2, 1]);
  assert.deepEqual(ids('oldest'), [1, 2]);
});

test('search refs prefer the INBOX label over the All Mail copy of the same message', () => {
  const { mail, account, inbox, archive, messages } = fixture();
  archive.name = 'All Mail';
  messages[0].mailbox = archive;
  archive.messages = collection(messages);
  account.mailboxes = collection([archive, inbox]);
  const result = dispatch(mail, 'search_messages', { from: '', sort: 'newest', limit: 5, account_id: 'a1', mailbox: null });
  assert.deepEqual(result.messages.map((m) => m.ref.mailbox), [['Inbox']]);
  assert.equal(dispatch(mail, 'read_message', { ref: result.messages[0].ref, max_chars: 4 }).body, 'Body');
});

test('global search hydrates one summary for limit one despite many matches and duplicate labels', () => {
  const { mail, inbox, archive, messages } = fixture(200);
  archive.messages = collection(messages);
  let subjects = 0;
  let ids = 0;
  let dates = 0;
  const measured = messages.map((message) => new Proxy(message, {
    get(target, key) {
      if (key === 'subject') return () => { subjects += 1; return 'Match'; };
      return Reflect.get(target, key);
    },
  }));
  inbox.messages = collection(measured);
  archive.messages = collection(measured);
  inbox.messages.id = () => { ids += 1; return messages.map((message) => message.id()); };
  inbox.messages.dateReceived = () => { dates += 1; return messages.map((message) => message.dateReceived()); };
  const result = dispatch(mail, 'search_messages', { from: '', sort: 'newest', limit: 1,
    account_id: 'a1', mailbox: null });
  assert.equal(result.messages.length, 1);
  assert.equal(result.has_more, true);
  assert.equal(subjects, 1);
  assert.equal(ids, 2);
  assert.equal(dates, 1);
});

test('global search rejects conflicting label dates and a result that changes after sorting', () => {
  const { mail, inbox, archive, messages } = fixture();
  const args = { from: '', sort: 'newest', limit: 1, account_id: 'a1', mailbox: null };
  archive.messages = collection([scripting({ id: 1, dateReceived: new Date('2020-01-01') })]);
  assert.throws(() => dispatch(mail, 'search_messages', args), /Duplicate message dates changed/);
  archive.messages = collection([]);
  const byId = inbox.messages.byId;
  inbox.messages.byId = (id) => {
    messages[0].dateReceived = new Date('2020-01-01');
    return byId(id);
  };
  assert.throws(() => dispatch(mail, 'search_messages', args), /Message changed/);
});
