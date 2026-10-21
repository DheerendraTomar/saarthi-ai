import type { IDisposable } from '@lumino/disposable';
import type { ConnectionState, WsCoreClient } from './client';

/** Shown once per `error` episode (spec: the server extension is missing or the env is wrong). */
export const UNREACHABLE_MESSAGE =
  'LocalPilot server extension not reachable — run `jupyter server extension list`; see the README';

/** JupyterLab's `Notification`, the part used here (a fake in tests). */
export interface UnreachableUi {
  /** Shows an error with a Retry action; returns its id. */
  show(message: string, retry: () => void): string;
  dismiss(id: string): void;
}

/**
 * The HTTP status of a failed `GET /localpilot/status` that means the
 * endpoint is not there (404: the server extension is not loaded) or not
 * allowed (403); undefined for anything else (network, 5xx).
 */
export function unreachableStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null | undefined)?.response?.status;
  return status === 403 || status === 404 ? status : undefined;
}

/**
 * Shows `UNREACHABLE_MESSAGE` with a Retry action (→ `client.reconnect()`)
 * when the client enters `error`, once until it next becomes `ready` (which
 * dismisses it).
 */
export function watchUnreachable(
  client: Pick<WsCoreClient, 'onStateChanged' | 'reconnect' | 'state'>,
  ui: UnreachableUi
): IDisposable {
  let shownId: string | undefined;
  let shown = false;
  const onState = (state: ConnectionState) => {
    if (state === 'error' && !shown) {
      shown = true;
      shownId = ui.show(UNREACHABLE_MESSAGE, () => client.reconnect());
    } else if (state === 'ready') {
      shown = false;
      if (shownId !== undefined) ui.dismiss(shownId);
      shownId = undefined;
    }
  };
  const subscription = client.onStateChanged(onState);
  if (client.state === 'error') onState('error');
  return subscription;
}
