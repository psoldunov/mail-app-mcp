'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { dispatch } = require('../src/mail_app_mcp/mail.js');
global.Automation = { getDisplayString: (value) => value.specifier };
let nextSpecifier = 0;

function collection(items) {
  const value = () => items.slice();
  Object.defineProperty(value, 'length', { get: () => items.length });
  items.forEach((item, index) => { value[index] = item; });
  value.whose = (criteria) => () => items.filter((item) =>
    Object.keys(criteria).every((key) => item[key]() === criteria[key]));
  value.slice = (start, end) => collection(items.slice(start, end + 1));
  value.subject = () => items.map((item) => item.subject());
  value.sender = () => items.map((item) => item.sender());
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
    dateReceived: new Date('2026-01-02T03:04:05Z'), readStatus: false, flaggedStatus: false,
    content: 'Body with secret', messageSize: 1000,
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

test('search references use the owning mailbox and reject a different account', () => {
  const { mail, archive, messages } = fixture();
  messages[0].mailbox = archive;
  archive.messages = collection(messages);
  const args = { account_id: 'a1', mailbox: ['Inbox'], offset: 0, limit: 20,
    query: 'hello', search_body: false };
  const result = dispatch(mail, 'list_messages', args);
  assert.deepEqual(result.messages[0].ref.mailbox, ['Archive']);
  assert.equal(dispatch(mail, 'read_message', { ref: result.messages[0].ref, max_chars: 4 }).body, 'Body');
  archive.account = scripting({ id: 'other-account' });
  assert.throws(() => dispatch(mail, 'list_messages', args), /account.*changed/);
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

test('search scans at most 200 messages and resumes even when first page has no matches', () => {
  const { mail } = fixture(201);
  const args = { account_id: 'a1', mailbox: ['Inbox'], offset: 0, limit: 10,
    query: 'NEEDLE', search_body: false };
  assert.deepEqual(dispatch(mail, 'list_messages', args),
    { messages: [], next_offset: 200, complete: false, scanned: 200 });
  const next = dispatch(mail, 'list_messages', { ...args, offset: 200 });
  assert.equal(next.messages[0].ref.message_id, 201);
  assert.equal(next.complete, true);
  assert.equal(next.next_offset, null);
  assert.equal(next.scanned, 1);
});

test('header search batches only its bounded scan window', () => {
  const { mail, inbox, messages } = fixture(201);
  inbox.messages = collection(messages.map((message) => new Proxy(message, { get(target, key) {
    if (['subject', 'sender', 'content'].includes(key)) assert.fail('Individual header or body was fetched');
    return target[key];
  } })));
  const ranges = [];
  inbox.messages.slice = (start, end) => {
    ranges.push([start, end]);
    return { subject: () => Array(10).fill('Other'), sender: () => Array(10).fill('other@example.com') };
  };
  assert.deepEqual(dispatch(mail, 'list_messages', { account_id: 'a1', mailbox: ['Inbox'],
    offset: 0, limit: 20, query: 'needle', search_body: false }),
  { messages: [], next_offset: 200, complete: false, scanned: 200 });
  assert.equal(ranges.length, 20);
  assert.deepEqual(ranges[0], [0, 9]);
  assert.deepEqual(ranges[19], [190, 199]);
});

test('search returns a resumable page when Mail exhausts the time budget', (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const { mail, inbox, messages } = fixture(2);
  inbox.messages.slice = () => ({
    subject: () => ['Hello [literal]', 'Hello [literal]'],
    sender: () => { now = 10001; return ['other@example.com', 'other@example.com']; },
  });
  const result = dispatch(mail, 'list_messages', { account_id: 'a1', mailbox: ['Inbox'],
    offset: 0, limit: 20, query: '', search_body: false });
  assert.equal(result.scanned, 1);
  assert.equal(result.next_offset, 1);
  assert.equal(result.complete, false);
  assert.equal(result.messages[0].ref.message_id, messages[0].id());
  inbox.messages = collection(messages);
  const next = dispatch(mail, 'list_messages', { account_id: 'a1', mailbox: ['Inbox'],
    offset: result.next_offset, limit: 20, query: '', search_body: false });
  assert.equal(next.messages[0].ref.message_id, messages[1].id());
  assert.equal(next.complete, true);
  assert.equal(next.next_offset, null);
});

test('search handles exhausted pages and rejects incomplete header batches', () => {
  const { mail, inbox } = fixture();
  inbox.messages.slice = () => assert.fail('Read beyond the last message');
  const args = { account_id: 'a1', mailbox: ['Inbox'], offset: 1, limit: 20, query: '', search_body: false };
  assert.deepEqual(dispatch(mail, 'list_messages', args),
    { messages: [], next_offset: null, complete: true, scanned: 0 });
  inbox.messages.slice = () => ({ subject: () => [], sender: () => ['other@example.com'] });
  assert.throws(() => dispatch(mail, 'list_messages', { ...args, offset: 0 }), /Mailbox changed/);
});

test('slow mailbox lookup fails instead of returning a nonadvancing continuation', (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const { mail, account } = fixture();
  const boxes = account.mailboxes();
  account.mailboxes = () => { now += 10001; return boxes; };
  assert.throws(() => dispatch(mail, 'list_messages', { account_id: 'a1', mailbox: ['Inbox'],
    offset: 0, limit: 20, query: '', search_body: false }), /too long/);
});

test('search rejects reordered messages rather than returning a nonmatching result', () => {
  const { mail, inbox, messages } = fixture(2);
  messages[1].subject = 'Unrelated';
  inbox.messages.slice = () => ({ subject: () => ['Needle', 'Unrelated'], sender: () => {
    inbox.messages[0] = messages[1];
    return ['other@example.com', 'other@example.com'];
  } });
  assert.throws(() => dispatch(mail, 'list_messages', { account_id: 'a1', mailbox: ['Inbox'],
    offset: 0, limit: 20, query: 'needle', search_body: false }), /Mailbox changed/);
});

test('reads bounded body only after exact reference validation', () => {
  const { mail, ref, messages } = fixture();
  const result = dispatch(mail, 'read_message', { ref, max_chars: 4 });
  assert.equal(result.body, 'Body');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.to, ['me@example.com']);
  assert.throws(() => dispatch(mail, 'read_message', {
    ref: { ...ref, header_message_id: '<stale>' }, max_chars: 4 }), /stale/i);
  messages[0].mailbox = fixture().archive;
  assert.throws(() => dispatch(mail, 'read_message', { ref, max_chars: 4 }), /mailbox|stale/i);
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
  const { mail, ref, messages } = fixture();
  for (const name of ['Localized outgoing', 'Localized drafts', 'Localized sent']) {
    assert.throws(() => dispatch(mail, 'move_message', { ref, destination: [name] }), /unsafe/i);
    assert.equal(messages[0].mailbox().name(), 'Inbox');
  }
  assert.deepEqual(dispatch(mail, 'move_message', { ref, destination: ['Archive'] }),
    { account_id: 'a1', destination: ['Archive'], moved: true });
  assert.equal(messages[0].mailbox().name(), 'Archive');
  assert.throws(() => dispatch(mail, 'move_message', { ref, destination: ['Inbox'] }), /stale/i);
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

function composing(mail) {
  const saved = [];
  const drafts = [];
  mail.outgoingMessages = collection(drafts);
  mail.OutgoingMessage = (properties) => Object.assign(scripting({ id: 42, ...properties }), {
    toRecipients: collection([]), ccRecipients: collection([]), bccRecipients: collection([]),
  });
  mail.ToRecipient = mail.CcRecipient = mail.BccRecipient = (properties) => scripting(properties);
  mail.save = (draft) => { saved.push(draft); };
  mail.send = () => assert.fail('must never send');
  mail.activate = () => assert.fail('must not activate without an explicit window request');
  return { saved, drafts };
}

test('creates and saves only a draft using an explicit account sender', () => {
  const { mail } = fixture();
  const { saved, drafts } = composing(mail);
  const args = { account_id: 'a1', sender: 'me@example.com', to: ['you@example.com'],
    cc: ['cc@example.com'], bcc: ['bcc@example.com'], subject: 'Subject', body: '<literal text>' };
  assert.throws(() => dispatch(mail, 'create_draft', { ...args, sender: 'imposter@example.com' }), /sender/i);
  assert.throws(() => dispatch(mail, 'create_draft', { ...args, account_id: '__local__' }), /local/i);
  assert.equal(drafts.length, 0);
  assert.deepEqual(dispatch(mail, 'create_draft', args),
    { draft_id: 42, account_id: 'a1', sender: 'me@example.com', status: 'draft' });
  assert.equal(saved.length, 1);
  assert.equal(saved[0], drafts[0]);
  assert.equal(saved[0].content(), '<literal text>');
  assert.equal(saved[0].visible(), false);
  assert.equal(saved[0].bccRecipients()[0].address(), 'bcc@example.com');
});

test('native reply preserves original content and saves without sending', () => {
  const { mail, ref, messages } = fixture();
  const { saved } = composing(mail);
  let replies = 0;
  mail.reply = (message, options) => {
    assert.equal(message, messages[0]);
    assert.deepEqual(options, { openingWindow: false, replyToAll: true });
    replies += 1;
    return mail.OutgoingMessage({ content: 'Original reply content', sender: 'wrong@example.com' });
  };
  const args = { ref, sender: 'me@example.com', body: 'My reply', reply_all: true };
  assert.throws(() => dispatch(mail, 'reply_draft', { ...args, sender: 'wrong@example.com' }), /sender/i);
  assert.equal(replies, 0);
  assert.deepEqual(dispatch(mail, 'reply_draft', args),
    { draft_id: 42, account_id: 'a1', sender: 'me@example.com', status: 'draft' });
  assert.equal(saved[0].content(), 'My reply\n\nOriginal reply content');
  assert.equal(saved[0].sender(), 'me@example.com');
});

function runtime(request, processes, application) {
  const context = vm.createContext({
    ObjC: { import() {}, unwrap: (value) => value },
    $: { NSUTF8StringEncoding: 4,
      NSFileHandle: { fileHandleWithStandardInput: { readDataToEndOfFile: JSON.stringify(request) } },
      NSString: { alloc: { initWithDataEncoding: (data) => data } },
      NSRunningApplication: { runningApplicationsWithBundleIdentifier: (id) => {
        assert.equal(id, 'com.apple.mail');
        return { count: processes.length, objectAtIndex: (index) => processes[index] };
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

test('stdin entrypoint never resolves an application for rejected operations or stopped Mail', () => {
  const forbidden = () => assert.fail('Application must not be resolved');
  assert.match(runtime({ operation: 'send', args: {} }, [], forbidden).error, /Unsupported/);
  assert.match(runtime({ operation: 'list_accounts', args: {} }, [], forbidden).error, /running/i);
  assert.match(runtime({ operation: 'list_accounts', args: {} },
    [{ processIdentifier: 123, terminated: true }], forbidden).error, /running/i);
});

test('unexpected entrypoint failure preserves the Python unknown-outcome latch', () => {
  const result = runtime({ operation: 'list_accounts', args: {} },
    [{ processIdentifier: 123, terminated: false }], () => { throw new Error('private runtime details'); });
  assert.equal(result.ok, false);
  assert.match(result.error, /^Outcome unknown:/);
  assert.doesNotMatch(result.error, /private runtime/);
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

test('explicit create and reply windows activate only after saving their draft', () => {
  const { mail, ref } = fixture();
  const { saved } = composing(mail);
  let activations = 0;
  mail.activate = () => {
    assert.equal(saved.length, activations + 1);
    assert.equal(saved[activations].visible(), true);
    activations += 1;
  };
  dispatch(mail, 'create_draft', { account_id: 'a1', sender: 'me@example.com',
    to: ['you@example.com'], cc: [], bcc: [], subject: '', body: '', open_window: true });
  mail.reply = () => mail.OutgoingMessage({ sender: 'me@example.com', content: 'original', visible: false });
  dispatch(mail, 'reply_draft', { ref, sender: 'me@example.com', body: 'reply', reply_all: false, open_window: true });
  assert.equal(activations, 2);
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

test('show_draft validates account, draft ID and sender before showing a specific draft', () => {
  const { mail } = fixture();
  const { drafts } = composing(mail);
  dispatch(mail, 'create_draft', { account_id: 'a1', sender: 'me@example.com',
    to: ['you@example.com'], cc: [], bcc: [], subject: '', body: '' });
  let activations = 0;
  mail.activate = () => { assert.equal(drafts[0].visible(), true); activations += 1; };
  const args = { account_id: 'a1', draft_id: 42, sender: 'me@example.com' };
  assert.throws(() => dispatch(mail, 'show_draft', { ...args, sender: 'wrong@example.com' }), /Sender/);
  assert.throws(() => dispatch(mail, 'show_draft', { ...args, draft_id: 43 }), /missing/);
  assert.equal(activations, 0);
  assert.deepEqual(dispatch(mail, 'show_draft', args), { shown: true, draft_id: 42, account_id: 'a1' });
  assert.equal(activations, 1);
});
