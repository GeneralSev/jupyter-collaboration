import { showDialog, Dialog } from '@jupyterlab/apputils';

/**
 * Extract error message from response error
 */
export function getErrorMessage(data: any, response: Response): string {
  if (typeof data === 'string') {
    return data;
  }
  if (data && data.message) {
    return data.message;
  }
  return response.statusText;
}

/**
 * Extract message from a ServerConnection.ResponseError
 */
export function messageFromResponseError(err: any): string {
  if (err && err.message) {
    return err.message;
  }
  if (err && err.response) {
    return err.response.statusText || 'Unknown error';
  }
  return 'Unknown error';
}

/**
 * Show file lock error dialog (blocking error - cannot open file)
 */
export async function showFileLockError(message: string): Promise<void> {
  await showDialog({
    title: 'File Locked',
    body: message,
    buttons: [Dialog.okButton({ label: 'OK' })]
  });
}

/**
 * Show file lock warning dialog (non-blocking - file opened in read-only mode)
 */
export async function showFileLockWarning(user: string): Promise<void> {
  await showDialog({
    title: 'Read-Only Mode',
    body: `File currently in use by ${user.toUpperCase()}; opened in read-only mode. 
    
    You can view and edit the document locally, but changes will not be saved.`,
    buttons: [Dialog.okButton({ label: 'Continue' })],
    hasClose: false
  });
}