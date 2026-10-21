/** A WebSocket stand-in driven by the test: `open()`, `receive()`, `serverClose()`. */
export class MockWebSocket {
  static instances: MockWebSocket[] = [];

  static reset(): void {
    MockWebSocket.instances = [];
  }

  static get last(): MockWebSocket {
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    if (!ws) throw new Error('no WebSocket was created');
    return ws;
  }

  readyState = 0;
  readonly sent: string[] = [];
  closedWith?: { code?: number; reason?: string };
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('WebSocket is not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? '', wasClean: true });
  }

  // ---- test side ----

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** The server (or the network) closes the socket. */
  serverClose(code: number, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (code === 1006) this.onerror?.({});
    this.onclose?.({ code, reason, wasClean: code !== 1006 });
  }

  /** Every JSON-RPC message this socket sent, parsed. */
  messages(): Array<{ id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }> {
    return this.sent.map((s) => JSON.parse(s));
  }

  /** Answers the request with `method` that this socket sent last. */
  respond(method: string, result: unknown): void {
    const req = [...this.messages()].reverse().find((m) => m.method === method && m.id !== undefined);
    if (!req) throw new Error(`no ${method} request was sent on ${this.url}`);
    this.receive({ jsonrpc: '2.0', id: req.id, result });
  }
}
