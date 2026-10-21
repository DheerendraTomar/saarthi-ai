import type { ConnectionState } from '../src/client';
import { UNREACHABLE_MESSAGE, unreachableStatus, watchUnreachable } from '../src/reachability';

class FakeClient {
  state: ConnectionState = 'connecting';
  private readonly listeners = new Set<(s: ConnectionState) => void>();
  reconnect = jest.fn();
  onStateChanged(listener: (s: ConnectionState) => void) {
    this.listeners.add(listener);
    return { isDisposed: false, dispose: () => this.listeners.delete(listener) };
  }
  set(state: ConnectionState): void {
    this.state = state;
    this.listeners.forEach((l) => l(state));
  }
}

describe('watchUnreachable', () => {
  it('notifies on each entry into error with a Retry that reconnects, and dismisses on ready', () => {
    const client = new FakeClient();
    const shown: Array<{ message: string; retry: () => void }> = [];
    const dismissed: string[] = [];
    const sub = watchUnreachable(client, {
      show: (message, retry) => {
        shown.push({ message, retry });
        return `n${shown.length}`;
      },
      dismiss: (id) => dismissed.push(id)
    });

    client.set('error');
    expect(shown).toHaveLength(1);
    expect(shown[0].message).toBe(UNREACHABLE_MESSAGE);
    expect(shown[0].message).toContain('jupyter server extension list');
    shown[0].retry(); // JupyterLab closes the toast on the click
    expect(client.reconnect).toHaveBeenCalledTimes(1);
    client.set('connecting');
    client.set('error'); // the retry failed: a fresh notification, the old one dismissed
    expect(shown).toHaveLength(2);
    expect(dismissed).toEqual(['n1']);

    client.set('ready');
    expect(dismissed).toEqual(['n1', 'n2']);
    client.set('reconnecting');
    expect(shown).toHaveLength(2);
    sub.dispose();
  });

  it('notifies at once when the client is already in error', () => {
    const client = new FakeClient();
    client.state = 'error';
    const show = jest.fn(() => 'n');
    watchUnreachable(client, { show, dismiss: jest.fn() });
    expect(show).toHaveBeenCalledTimes(1);
  });
});

describe('unreachableStatus', () => {
  it('picks out 403 and 404 answers of the status request', () => {
    expect(unreachableStatus({ response: { status: 404 } })).toBe(404);
    expect(unreachableStatus({ response: { status: 403 } })).toBe(403);
    expect(unreachableStatus({ response: { status: 500 } })).toBeUndefined();
    expect(unreachableStatus(new TypeError('Failed to fetch'))).toBeUndefined();
    expect(unreachableStatus(undefined)).toBeUndefined();
  });
});
