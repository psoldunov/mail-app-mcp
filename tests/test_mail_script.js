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
  value.whose = (criteria) => collection(items.filter((item) =>
    Object.keys(criteria).every((key) => typeof criteria[key] === 'object'
      ? item[key]().toLowerCase().includes(criteria[key]._contains.toLowerCase())
      : item[key]() === criteria[key])));
  value.slice = (start, end) => collection(items.slice(start, end + 1));
  value.subject = () => items.map((item) => item.subject());
  value.id = () => items.map((item) => item.id());
  value.dateReceived = () => items.map((item) => item.dateReceived());
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

test('zero outgoing IDs can be saved, replied and shown without accepting ambiguous drafts', () => {
  const { mail, ref } = fixture();
  const { saved, drafts } = composing(mail);
  const make = mail.OutgoingMessage;
  mail.OutgoingMessage = (properties) => { const draft = make(properties); draft.id = 0; return draft; };
  const args = { account_id: 'a1', sender: 'me@example.com', to: ['you@example.com'],
    cc: [], bcc: [], subject: 'Test', body: 'Body' };
  assert.equal(dispatch(mail, 'create_draft', args).draft_id, 0);
  assert.equal(saved.length, 1);
  mail.activate = () => {};
  const show = { account_id: 'a1', sender: args.sender, draft_id: 0 };
  assert.equal(dispatch(mail, 'show_draft', show).shown, true);
  mail.reply = () => mail.OutgoingMessage({ content: 'Quote', sender: args.sender });
  assert.equal(dispatch(mail, 'reply_draft', { ref, sender: args.sender, body: 'Reply', reply_all: false }).draft_id, 0);
  mail.outgoingMessages = collection([drafts[0], drafts[0]]);
  assert.throws(() => dispatch(mail, 'show_draft', show), /ambiguous/);
  assert.throws(() => dispatch(mail, 'show_draft', { ...show, draft_id: -1 }), /Invalid/);
});

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
  inbox.messages = { length: 20001, id: () => assert.fail('Oversize metadata fetched') };
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
  mail.mailboxes = () => { time = 20001; return []; };
  assert.throws(() => dispatch(mail, 'search_messages', args), /latest match not established/);
});

test('sender filter stays in Mail and only selected summaries fetch subjects', () => {
  const { mail, inbox, messages } = fixture(1000);
  messages[999].sender = 'Isabel';
  messages.forEach((message, index) => {
    message.content = () => assert.fail('Search fetched body');
    if (index !== 999) message.subject = () => assert.fail('Nonmatch summary fetched');
  });
  let predicate;
  inbox.messages.whose = (criteria) => {
    if (criteria.sender) {
      predicate = criteria;
      return collection([messages[999]]);
    }
    return collection(messages.filter((m) => m.id() === criteria.id));
  };
  const result = dispatch(mail, 'search_messages', { from: 'Isabel', sort: 'newest', limit: 1,
    account_id: 'a1', mailbox: null });
  assert.deepEqual(predicate, { sender: { _contains: 'Isabel' } });
  assert.equal(result.matched_candidates, 1);
  assert.equal(result.messages[0].ref.message_id, 1000);
  assert.ok(result.timing_ms.total >= 0);
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
  inbox.messages.whose = () => {
    messages[0].dateReceived = new Date('2020-01-01');
    return collection(messages);
  };
  assert.throws(() => dispatch(mail, 'search_messages', args), /Message changed/);
});
