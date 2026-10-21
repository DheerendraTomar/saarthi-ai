import type { IDisposable } from '@lumino/disposable';
import type { ConnectionState, WsCoreClient } from './client';

/** Shown on entering `error` (the server extension is missing, the env is wrong, or no permission). */
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
 * each time the client enters `error` (JupyterLab closes the toast when Retry
 * is clicked, so a retry that fails again shows a new one), replacing any
 * earlier one; `ready` dismisses it.
 */
export function watchUnreachable(
  client: Pick<WsCoreClient, 'onStateChanged' | 'reconnect' | 'state'>,
  ui: UnreachableUi
): IDisposable {
  let shownId: string | undefined;
  let last: ConnectionState | undefined;
  const dismiss = () => {
    if (shownId !== undefined) ui.dismiss(shownId);
    shownId = undefined;
  };
  const onState = (state: ConnectionState) => {
    const previous = last;
    last = state;
    if (state === 'error' && previous !== 'error') {
      dismiss();
      shownId = ui.show(UNREACHABLE_MESSAGE, () => client.reconnect());
    } else if (state === 'ready') {
      dismiss();
    }
  };
  const subscription = client.onStateChanged(onState);
  if (client.state === 'error') onState('error');
  return subscription;
}
