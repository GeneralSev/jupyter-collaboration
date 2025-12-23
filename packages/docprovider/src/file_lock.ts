import { Dialog, showDialog } from '@jupyterlab/apputils';
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
  const username = message.slice(-3).toLowerCase();
  let email: string | undefined = '';

  try {
    const response = await fetch('/srv/collaboration/username_map.json');
    const mapping = await response.json();
    email = Object.keys(mapping).find(key => mapping[key] === username);
  } catch (e) {
    console.error('Failed to map username to email', e);
  }

  const buttons = [Dialog.okButton()];
  const teamsButton = Dialog.createButton({
    label: 'Teams chat with user',
    accept: true
  });
  if (email) {
    buttons.push(teamsButton);
  }

  const result = await showDialog({
    title: 'File lock error',
    body: message,
    buttons
  });

  if (email && result.button.label === 'Teams chat with user') {
    window.open(
      `https://teams.microsoft.com/l/chat/0/0?users=${email}`,
      '_blank'
    );
  }

  return result;
}
