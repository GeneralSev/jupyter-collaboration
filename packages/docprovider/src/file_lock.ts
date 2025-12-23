import { Dialog, showErrorMessage } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';

export function messageFromResponseError(err: unknown): string {
  if (err instanceof ServerConnection.ResponseError) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Best-effort extraction of a human-readable message from server error payloads.
 */
export function getErrorMessage(data: any, response?: Response): string {
  if (data !== null) {
    if (typeof data === 'string') {
      return data;
    }
    return data.message || response?.statusText || 'Unknown error';
  } else {
    return response?.statusText || 'Unknown error';
  }
}

export async function showFileLockError(message: string) {
  return showErrorMessage(
    'File lock error',
    message,
    [Dialog.okButton()]
  );
}
