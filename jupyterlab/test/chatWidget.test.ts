import { readFileSync } from 'fs';
import { join } from 'path';
import { Widget } from '@lumino/widgets';
import { CoreDisconnected } from '../src/client';
import { CHAT_WIDGET_ID, ChatWidget, renderHtml, type ChatClient, type ChatWidgetDeps } from '../src/chat/chatWidget';
import { THEME_MAP, jupyterThemeVars } from '../src/chat/theme';

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
    themeVars: () => ({ '--vscode-foreground': '#101010' }),
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
    expect(doc).toContain('<style id="lp-host-theme">:root{--vscode-foreground:#101010;}</style>');
  });

  it('render_html_injects_mapped_theme_vars', () => {
    const tpl = '<!doctype html><html><head><title>x</title></head><body></body></html>';
    const doc = renderHtml(tpl, {
      '--vscode-foreground': 'rgba(0, 0, 0, 0.87)',
      '--vscode-font-family': '"Fira Sans", system-ui',
      '--vscode-bad': 'red;}</style><script>alert(1)</script>',
      color: 'red'
    });
    expect(doc).toContain('<style id="lp-host-theme">:root{--vscode-foreground:rgba(0, 0, 0, 0.87);--vscode-font-family:"Fira Sans", system-ui;}</style>');
    expect(doc).not.toContain('alert');
    expect(doc).not.toContain('color:red');
    // Before the page's own styles (the bundle's <style> in <head> reads them).
    expect(doc.indexOf('lp-host-theme')).toBeLessThan(doc.indexOf('<title>'));
  });

  it('maps_jupyterlab_theme_variables_onto_vscode_names', () => {
    const values: Record<string, string> = {
      '--jp-ui-font-color1': ' rgba(0, 0, 0, 0.87)',
      '--jp-layout-color1': 'white',
      '--jp-brand-color1': '#1976d2',
      '--jp-code-font-family': 'Menlo, monospace'
    };
    const vars = jupyterThemeVars((name) => values[name] ?? '');
    expect(vars['--vscode-foreground']).toBe('rgba(0, 0, 0, 0.87)');
    expect(vars['--vscode-sideBar-background']).toBe('white');
    expect(vars['--vscode-button-background']).toBe('#1976d2');
    expect(vars['--vscode-focusBorder']).toBe('#1976d2');
    expect(vars['--vscode-editor-font-family']).toBe('Menlo, monospace');
    expect(vars['--vscode-descriptionForeground']).toBeUndefined(); // empty → keep the bundle's fallback
    // Every --vscode-* name chat-ui's styles.css reads, except the diff backgrounds (translucent, theme-neutral).
    const css = readFileSync(join(__dirname, '..', '..', 'chat-ui', 'src', 'styles.css'), 'utf8');
    const used = new Set([...css.matchAll(/var\((--vscode-[A-Za-z0-9.-]+)/g)].map((m) => m[1]));
    const mapped = new Set(Object.keys(THEME_MAP));
    const missing = [...used].filter((n) => !mapped.has(n) && !n.startsWith('--vscode-diffEditor-'));
    expect(missing).toEqual([]);
  });

  it('theme_change_posts_ui_theme', () => {
    let vars: Record<string, string> = { '--vscode-foreground': '#101010' };
    const { widget, posted } = setup({ themeVars: () => vars });
    current = widget;
    widget.themeChanged(); // unchanged since the srcdoc: nothing to send
    expect(posted).toEqual([]);
    vars = { '--vscode-foreground': '#eeeeee', '--vscode-sideBar-background': '#111111' };
    widget.themeChanged();
    widget.themeChanged();
    expect(posted).toEqual([{ type: 'ui/theme', vars }]);
    // srcdoc is not reset (that would reload the frame and lose the draft).
    expect(widget.iframe.getAttribute('srcdoc')).toContain('--vscode-foreground:#101010');
  });

  it('adopted_session_with_replayed_pending_call_is_running', async () => {
    const { client, deps, widget, posted, fromUi } = setup();
    current = widget;
    await fromUi({ type: 'ui/ready' });
    // s1 was started in another tab; the bridge replays its pending call after our chat/history.
    posted.length = 0;
    const call = { sessionId: 's1', toolCallId: 'tx', name: 'edit_file', args: { path: 'a.py' }, requiresApproval: true };
    client.notifyUi('chat/toolCall', call);
    expect(posted).toEqual([
      { type: 'chat/toolCall', ...call },
      { type: 'chat/turnState', sessionId: 's1', running: true }
    ]);
    expect(deps.onChatActiveChanged).toHaveBeenLastCalledWith(true);
    await fromUi({ type: 'chat/stop' });
    expect(client.calls.at(-1)).toEqual(['chat/stop', { sessionId: 's1' }]);
    client.notifyUi('chat/done', { sessionId: 's1', stopReason: 'stopped' });
    expect(deps.onChatActiveChanged).toHaveBeenLastCalledWith(false);
  });

  it('chatWidget_relays_send_with_session_and_forwards_tokens', async () => {
    const { client, deps, widget, posted, fromUi, types } = setup();
    current = widget;

    await fromUi({ type: 'ui/ready' });
    // The session list first (the UI keys tool cards by session), then its history.
    expect(client.methods()).toEqual(['chat/listSessions', 'chat/history']);
    expect(types()).toEqual(['session/list', 'session/history', 'chat/turnState', 'ui/theme', 'ui/activeFile']);
    expect(posted[0]).toEqual({ type: 'session/list', sessions: SESSIONS, current: 's1' });
    expect(posted[1]).toEqual({ type: 'session/history', sessionId: 's1', messages: [{ role: 'user', content: 'hello s1' }] });
    expect(posted[3]).toEqual({ type: 'ui/theme', vars: { '--vscode-foreground': '#101010' } });
    expect(posted[4]).toEqual({ type: 'ui/activeFile', uri: CELL, selection: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } } });

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
    expect(types()).toEqual(['session/list', 'ui/theme', 'ui/activeFile']);
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
