import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBridge, IframeBridge, TestBridge } from "../src/host";
import type { HostToUi, UiToHost } from "../src/host";

type W = Window & {
  acquireVsCodeApi?: unknown;
  cefQuery?: unknown;
};

afterEach(() => {
  delete (window as W).acquireVsCodeApi;
  delete (window as W).cefQuery;
});

function dispatchHostMessage(msg: HostToUi) {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

describe("createHostBridge", () => {
  it("createHostBridge_uses_vscode_api_when_present", () => {
    let stored: unknown = { draft: "hi" };
    const api = {
      postMessage: vi.fn(),
      getState: vi.fn(() => stored),
      setState: vi.fn((s: unknown) => {
        stored = s;
      }),
    };
    const acquire = vi.fn(() => api);
    (window as W).acquireVsCodeApi = acquire;
    (window as W).cefQuery = vi.fn(); // VS Code must win over JCEF

    const bridge = createHostBridge();
    expect(bridge).not.toBeInstanceOf(TestBridge);
    expect(acquire).toHaveBeenCalledTimes(1);

    const msg: UiToHost = { type: "chat/send", message: "hello", attachments: [] };
    bridge.post(msg);
    expect(api.postMessage).toHaveBeenCalledWith(msg);
    expect((window as W).cefQuery).not.toHaveBeenCalled();

    expect(bridge.getState<{ draft: string }>()).toEqual({ draft: "hi" });
    bridge.setState({ draft: "bye" });
    expect(api.setState).toHaveBeenCalledWith({ draft: "bye" });
    expect(bridge.getState()).toEqual({ draft: "bye" });

    const received: HostToUi[] = [];
    const off = bridge.onMessage((m) => received.push(m));
    const token: HostToUi = { type: "chat/token", sessionId: "s1", delta: "a", kind: "text" };
    dispatchHostMessage(token);
    off();
    dispatchHostMessage({ type: "ui/error", message: "after unsubscribe" });
    expect(received).toEqual([token]);
  });

  it("uses_cefQuery_adapter_when_no_vscode_api", () => {
    const cefQuery = vi.fn();
    (window as W).cefQuery = cefQuery;

    const bridge = createHostBridge();
    expect(bridge).not.toBeInstanceOf(TestBridge);
    bridge.post({ type: "ui/ready" });
    expect(cefQuery).toHaveBeenCalledTimes(1);
    const arg = cefQuery.mock.calls[0][0] as { request: string };
    expect(JSON.parse(arg.request)).toEqual({ type: "ui/ready" });

    const received: HostToUi[] = [];
    bridge.onMessage((m) => received.push(m));
    const status: HostToUi = { type: "status", ollama: "ok", detail: "" };
    dispatchHostMessage(status);
    expect(received).toEqual([status]);

    expect(bridge.getState()).toBeUndefined();
    bridge.setState({ n: 1 });
    expect(bridge.getState()).toEqual({ n: 1 });
  });

  it("falls_back_to_test_bridge", () => {
    expect(createHostBridge()).toBeInstanceOf(TestBridge);
  });
});

describe("IframeBridge", () => {
  it("iframe_bridge_posts_to_parent_and_receives_from_parent", () => {
    const parent = { postMessage: vi.fn() };
    const bridge = new IframeBridge(parent as unknown as Window);
    const msg: UiToHost = { type: "chat/approve", toolCallId: "t1", decision: "once", editedArgs: { path: "a.py" } };
    bridge.post(msg);
    expect(parent.postMessage).toHaveBeenCalledWith(msg, "*");

    const received: HostToUi[] = [];
    const off = bridge.onMessage((m) => received.push(m));
    const token: HostToUi = { type: "chat/token", sessionId: "s1", delta: "hi", kind: "text" };
    // From the parent (the JupyterLab host page): delivered.
    window.dispatchEvent(new MessageEvent("message", { data: token, source: parent as unknown as Window }));
    // From anything else (another frame, the page itself): ignored.
    window.dispatchEvent(new MessageEvent("message", { data: { type: "ui/error", message: "spoofed" }, source: window }));
    // Not a host message: ignored.
    window.dispatchEvent(new MessageEvent("message", { data: "noise", source: parent as unknown as Window }));
    off();
    window.dispatchEvent(new MessageEvent("message", { data: token, source: parent as unknown as Window }));
    expect(received).toEqual([token]);

    expect(bridge.getState()).toBeUndefined();
    bridge.setState({ draft: "x" });
    expect(bridge.getState()).toEqual({ draft: "x" });
  });

  it("createHostBridge_uses_iframe_bridge_when_framed", () => {
    const parent = { postMessage: vi.fn() };
    const original = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", { value: parent, configurable: true });
    try {
      const bridge = createHostBridge();
      expect(bridge).toBeInstanceOf(IframeBridge);
      bridge.post({ type: "ui/ready" });
      expect(parent.postMessage).toHaveBeenCalledWith({ type: "ui/ready" }, "*");

      // VS Code webviews are iframes too: the VS Code API still wins.
      const api = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
      (window as W).acquireVsCodeApi = () => api;
      expect(createHostBridge()).not.toBeInstanceOf(IframeBridge);
      delete (window as W).acquireVsCodeApi;
      (window as W).cefQuery = vi.fn();
      expect(createHostBridge()).not.toBeInstanceOf(IframeBridge);
    } finally {
      if (original) Object.defineProperty(window, "parent", original);
      else delete (window as unknown as { parent?: unknown }).parent;
    }
    expect(window.parent).toBe(window);
  });
});

describe("TestBridge", () => {
  it("test_bridge_records_posts_and_emits", () => {
    const bridge = new TestBridge();
    bridge.post({ type: "ui/ready" });
    bridge.post({ type: "chat/approve", toolCallId: "t1", decision: "always" });
    expect(bridge.sent).toEqual([
      { type: "ui/ready" },
      { type: "chat/approve", toolCallId: "t1", decision: "always" },
    ]);

    const a: HostToUi[] = [];
    const b: HostToUi[] = [];
    const offA = bridge.onMessage((m) => a.push(m));
    bridge.onMessage((m) => b.push(m));
    const done: HostToUi = { type: "chat/done", sessionId: "s1", stopReason: "contextFull" };
    bridge.emit(done);
    offA();
    const err: HostToUi = { type: "ui/error", message: "boom" };
    bridge.emit(err);
    expect(a).toEqual([done]);
    expect(b).toEqual([done, err]);

    expect(bridge.getState()).toBeUndefined();
    bridge.setState({ scroll: 3 });
    expect(bridge.getState<{ scroll: number }>()).toEqual({ scroll: 3 });
  });
});
