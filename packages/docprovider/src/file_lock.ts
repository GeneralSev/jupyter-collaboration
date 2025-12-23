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

export async function showFileLockError(message: string) {
  return showErrorMessage(
    'File lock error',
    message,
    [Dialog.okButton()]
  );
}
