import { Widget } from '@lumino/widgets';
import { CoreDisconnected } from '../src/client';
import { CHAT_WIDGET_ID, ChatWidget, type ChatClient, type ChatWidgetDeps } from '../src/chat/chatWidget';

// A fake core client: canned answers per method, captured notification
// handlers and disconnect listeners. The widget's iframe is real (jsdom); its
// UI side is simulated by dispatching `message` events whose source is the
// iframe's window, and by spying on that window's postMessage.

type Handler = (params: unknown) => void;

class FakeClient implements ChatClient {
  isDisposed = false;
  readonly calls: Array<[string, unknown]> = [];
  readonly answers = new Map<string, (params: Record<string, unknown>) => unknown>();
  private readonly handlers = new Map<string, Handler[]>();
  private readonly disconnects: Array<(e: CoreDisconnected) => void> = [];

  request = jest.fn(async <T>(method: string, params?: unknown): Promise<T> => {
    this.calls.push([method, params]);
    const answer = this.answers.get(method);
    return (answer ? await answer((params ?? {}) as Record<string, unknown>) : {}) as T;
  }) as ChatClient['request'];

  onNotification(method: string, handler: Handler) {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
    return { isDisposed: false, dispose: () => list.splice(list.indexOf(handler), 1) };
  }
  onDisconnect(listener: (e: CoreDisconnected) => void) {
    this.disconnects.push(listener);
    return { isDisposed: false, dispose: () => undefined };
  }
  notifyUi(method: string, params: unknown): void {
    for (const h of this.handlers.get(method) ?? []) h(params);
  }
  disconnect(): void {
    for (const l of this.disconnects) l(new CoreDisconnected(1012, 'core exited'));
  }
  methods(): string[] {
    return this.calls.map(([m]) => m);
  }
}

const SESSIONS = [
  { sessionId: 's1', title: 'first', updatedAtMs: 2 },
  { sessionId: 's2', title: 'second', updatedAtMs: 1 }
];
const CELL = 'file:///root/nb.ipynb.cell0.py';

function setup(overrides: Partial<ChatWidgetDeps> = {}) {
  const client = new FakeClient();
  client.answers.set('chat/listSessions', () => ({ sessions: SESSIONS }));
  client.answers.set('chat/history', (p) => ({ sessionId: p.sessionId, messages: [{ role: 'user', content: `hello ${p.sessionId}` }] }));
  const deps: ChatWidgetDeps = {
    html: () => '<!doctype html><html><head></head><body>chat</body></html>',
    activeFile: () => ({ uri: CELL, selection: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } } }),
    isSyncedUri: (uri) => uri === CELL,
    insertAtCursor: jest.fn(() => true),
    startOllama: jest.fn(),
    pullModel: jest.fn(async () => undefined),
    onChatActiveChanged: jest.fn(),
    ...overrides
  };
  const widget = new ChatWidget(client, deps);
  Widget.attach(widget, document.body);
  const frame = widget.iframe.contentWindow!;
  const posted: Array<Record<string, unknown>> = [];
  jest.spyOn(frame, 'postMessage').mockImplementation(((msg: Record<string, unknown>) => {
    posted.push(msg);
  }) as typeof frame.postMessage);
  const fromUi = async (data: unknown, source: unknown = frame) => {
    window.dispatchEvent(new MessageEvent('message', { data, source: source as Window }));
    // Let the relay's request chain settle.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  const types = () => posted.map((m) => m.type);
  return { client, deps, widget, frame, posted, fromUi, types };
}

let current: ChatWidget | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});

describe('ChatWidget', () => {
  it('hosts the chat bundle in a sandboxed iframe', () => {
    const { widget } = setup();
    current = widget;
    expect(widget.id).toBe(CHAT_WIDGET_ID);
    expect(CHAT_WIDGET_ID).toBe('localpilot-chat');
    expect(widget.iframe.getAttribute('sandbox')).toBe('allow-scripts allow-popups allow-popups-to-escape-sandbox');
    const doc = widget.iframe.getAttribute('srcdoc')!;
    expect(doc).toContain('<body>chat</body>');
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain('<base target="_blank">');
  });

  it('chatWidget_relays_send_with_session_and_forwards_tokens', async () => {
    const { client, deps, widget, posted, fromUi, types } = setup();
    current = widget;

    await fromUi({ type: 'ui/ready' });
    // The session list first (the UI keys tool cards by session), then its history.
    expect(client.methods()).toEqual(['chat/listSessions', 'chat/history']);
    expect(types()).toEqual(['session/list', 'session/history', 'chat/turnState', 'ui/activeFile']);
    expect(posted[0]).toEqual({ type: 'session/list', sessions: SESSIONS, current: 's1' });
    expect(posted[1]).toEqual({ type: 'session/history', sessionId: 's1', messages: [{ role: 'user', content: 'hello s1' }] });
    expect(posted[3]).toEqual({ type: 'ui/activeFile', uri: CELL, selection: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } } });

    await fromUi({
      type: 'chat/send',
      message: 'explain',
      attachments: [{ uri: CELL, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } }, { uri: 'file:///etc/passwd' }, { uri: CELL, range: 'bad' }]
    });
    expect(client.calls[2]).toEqual([
      'chat/send',
      {
        sessionId: 's1',
        message: 'explain',
        attachments: [{ uri: CELL, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } }, { uri: CELL }]
      }
    ]);
    expect(deps.onChatActiveChanged).toHaveBeenLastCalledWith(true);

    posted.length = 0;
    client.notifyUi('chat/token', { sessionId: 's1', delta: 'It ', kind: 'text' });
    client.notifyUi('chat/done', { sessionId: 's1', stopReason: 'done' });
    expect(posted.slice(0, 2)).toEqual([
      { type: 'chat/token', sessionId: 's1', delta: 'It ', kind: 'text' },
      { type: 'chat/done', sessionId: 's1', stopReason: 'done' }
    ]);
    expect(deps.onChatActiveChanged).toHaveBeenLastCalledWith(false);

    // Messages from anything but the iframe are ignored.
    const before = client.calls.length;
    await fromUi({ type: 'chat/send', message: 'spoofed', attachments: [] }, window);
    expect(client.calls.length).toBe(before);
    expect(client.methods().filter((m) => m === 'chat/send')).toHaveLength(1);
  });

  it('starts_a_session_when_none_exists', async () => {
    const { client, widget, fromUi, types } = setup();
    current = widget;
    client.answers.set('chat/listSessions', () => ({ sessions: [] }));
    client.answers.set('chat/newSession', () => ({ sessionId: 'new1' }));
    await fromUi({ type: 'ui/ready' });
    expect(types()).toEqual(['session/list', 'ui/activeFile']);
    await fromUi({ type: 'chat/send', message: 'hi', attachments: [] });
    expect(client.calls.find(([m]) => m === 'chat/send')).toEqual(['chat/send', { sessionId: 'new1', message: 'hi', attachments: [] }]);
    expect(widget.currentSessionId).toBe('new1');
  });

  it('chatWidget_forwards_editedArgs_unchanged', async () => {
    const { client, widget, fromUi } = setup();
    current = widget;
    await fromUi({ type: 'ui/ready' });
    // A tool call of another (background) session: approve goes to that session.
    client.notifyUi('chat/toolCall', { sessionId: 's2', toolCallId: 't9', name: 'edit_file', args: { path: 'a.py', old: 'x', new: 'y' }, requiresApproval: true });
    const editedArgs = { path: 'a.py', old: 'x', new: 'z', extra: [1, { deep: true }] };
    await fromUi({ type: 'chat/approve', toolCallId: 't9', decision: 'once', editedArgs });
    expect(client.calls.at(-1)).toEqual(['chat/approve', { sessionId: 's2', toolCallId: 't9', decision: 'once', editedArgs }]);

    await fromUi({ type: 'chat/approve', toolCallId: 't9', decision: 'reject' });
    expect(client.calls.at(-1)).toEqual(['chat/approve', { sessionId: 's2', toolCallId: 't9', decision: 'reject' }]);
  });

  it('pending_approvals_reposted_after_history', async () => {
    const { client, widget, posted, fromUi, types } = setup();
    current = widget;
    await fromUi({ type: 'ui/ready' });
    await fromUi({ type: 'chat/send', message: 'edit it', attachments: [] });
    const call = { sessionId: 's1', toolCallId: 't1', name: 'edit_file', args: { path: 'a.py' }, requiresApproval: true, preview: { diff: '-a\n+b' } };
    client.notifyUi('chat/toolCall', call);
    client.notifyUi('chat/toolCall', { sessionId: 's1', toolCallId: 't0', name: 'read_file', args: { path: 'b.py' }, requiresApproval: false });

    await fromUi({ type: 'chat/switchSession', sessionId: 's2' });
    posted.length = 0;
    await fromUi({ type: 'chat/switchSession', sessionId: 's1' });
    expect(types()).toEqual(['session/list', 'session/history', 'chat/toolCall', 'chat/turnState']);
    expect(posted[2]).toEqual({ type: 'chat/toolCall', ...call });
    expect(posted[3]).toEqual({ type: 'chat/turnState', sessionId: 's1', running: true });

    // Decided: not offered again.
    await fromUi({ type: 'chat/approve', toolCallId: 't1', decision: 'once' });
    posted.length = 0;
    await fromUi({ type: 'chat/switchSession', sessionId: 's1' });
    expect(types()).toEqual(['session/list', 'session/history', 'chat/turnState']);
  });

  it('stop_targets_the_running_session', async () => {
    const { client, widget, posted, fromUi } = setup();
    current = widget;
    await fromUi({ type: 'ui/ready' });
    await fromUi({ type: 'chat/send', message: 'go', attachments: [] });
    await fromUi({ type: 'chat/switchSession', sessionId: 's2' });
    await fromUi({ type: 'chat/stop' });
    expect(client.calls.at(-1)).toEqual(['chat/stop', { sessionId: 's1' }]);

    client.notifyUi('chat/done', { sessionId: 's1', stopReason: 'stopped' });
    posted.length = 0;
    await fromUi({ type: 'chat/stop' });
    // Nothing running: s2 is the session on screen.
    expect(client.calls.filter(([m]) => m === 'chat/stop').at(-1)).toEqual(['chat/stop', { sessionId: 's2' }]);
  });

  it('core_disconnect_mid_turn_shows_error', async () => {
    const { client, deps, widget, posted, fromUi, types } = setup();
    current = widget;
    let rejectSend: (e: unknown) => void = () => undefined;
    client.answers.set('chat/send', () => new Promise((_, reject) => (rejectSend = reject)));
    await fromUi({ type: 'ui/ready' });
    await fromUi({ type: 'chat/send', message: 'long', attachments: [] });
    client.notifyUi('chat/token', { sessionId: 's1', delta: 'par', kind: 'text' });
    posted.length = 0;

    client.disconnect();
    rejectSend(new CoreDisconnected(1012, 'core exited'));
    await fromUi({ type: 'noop' });

    expect(types()).toEqual(['chat/done', 'ui/error']);
    expect(posted[0]).toEqual({ type: 'chat/done', sessionId: 's1', stopReason: 'error' });
    expect(String(posted[1].message)).toMatch(/core stopped during the reply/);
    expect(deps.onChatActiveChanged).toHaveBeenLastCalledWith(false);

    // A disconnect with no turn running says nothing.
    posted.length = 0;
    client.disconnect();
    expect(posted).toEqual([]);
  });

  it('routes_editor_and_ollama_messages_to_the_host', async () => {
    const { client, deps, widget, posted, fromUi } = setup();
    current = widget;
    await fromUi({ type: 'ui/insertAtCursor', text: 'print(1)' });
    expect(deps.insertAtCursor).toHaveBeenCalledWith('print(1)');
    await fromUi({ type: 'ollama/start' });
    expect(deps.startOllama).toHaveBeenCalledTimes(1);
    await fromUi({ type: 'ollama/pull', model: '' });
    expect(deps.pullModel).toHaveBeenCalledWith('');
    client.notifyUi('ollama/pullProgress', { model: 'm', status: 'pulling', completed: 1, total: 2 });
    expect(posted.at(-1)).toEqual({ type: 'ollama/pullProgress', model: 'm', status: 'pulling', completed: 1, total: 2 });
    await fromUi({ type: 'ui/openDiff', toolCallId: 'x' });
    await fromUi({ type: 'bogus' });
    expect(client.calls).toEqual([]);
  });

  it('insert_without_an_editor_reports_an_error', async () => {
    const { widget, posted, fromUi } = setup({ insertAtCursor: () => false });
    current = widget;
    await fromUi({ type: 'ui/insertAtCursor', text: 'x' });
    expect(posted.at(-1)).toEqual({ type: 'ui/error', message: expect.stringMatching(/open a notebook cell or an editor/) });
  });

  it('active_file_updates_are_deduplicated', async () => {
    let target: { uri: string } | undefined = { uri: CELL };
    const { widget, posted } = setup({ activeFile: () => target });
    current = widget;
    widget.activeFileChanged();
    widget.activeFileChanged();
    target = undefined;
    widget.activeFileChanged();
    expect(posted).toEqual([
      { type: 'ui/activeFile', uri: CELL },
      { type: 'ui/activeFile', uri: null }
    ]);
  });
});
