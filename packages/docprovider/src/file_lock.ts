import { showDialog, Dialog } from '@jupyterlab/apputils';

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