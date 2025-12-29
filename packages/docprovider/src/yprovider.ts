/* -----------------------------------------------------------------------------
| Copyright (c) Jupyter Development Team.
| Distributed under the terms of the Modified BSD License.
|----------------------------------------------------------------------------*/

import { IDocumentProvider } from '@jupyter/collaborative-drive';
import { showErrorMessage, Dialog } from '@jupyterlab/apputils';
import { User } from '@jupyterlab/services';
import { TranslationBundle } from '@jupyterlab/translation';
import { ServerConnection } from '@jupyterlab/services';
import { PromiseDelegate } from '@lumino/coreutils';
import { Signal, ISignal } from '@lumino/signaling';

import { DocumentChange, YDocument } from '@jupyter/ydoc';

import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider as YWebsocketProvider } from 'y-websocket';

import { requestDocSession } from './requests';
import { IForkProvider } from './ydrive';
import { messageFromResponseError, showFileLockError } from './file_lock';

/**
 * A class to provide Yjs synchronization over WebSocket.
 *
 * We specify custom messages that the server can interpret. For reference please look in yjs_ws_server.
 *
 */

export class WebSocketProvider implements IDocumentProvider, IForkProvider {
  /**
   * Construct a new WebSocketProvider
   *
   * @param options The instantiation options for a WebSocketProvider
   */
  constructor(options: WebSocketProvider.IOptions) {
    this._isDisposed = false;
    this._isReadOnly = false;
    this._lockedBy = null;
    this._path = options.path;
    this._contentType = options.contentType;
    this._format = options.format;
    this._serverUrl = options.url;
    this._sharedModel = options.model;
    this._awareness = options.model.awareness;
    this._yWebsocketProvider = null;
    this._trans = options.translator;
    this._readOnlyChanged = new Signal(this);

    const user = options.user;

    user.ready
      .then(() => {
        this._onUserChanged(user);
      })
      .catch(e => console.error(e));
    user.userChanged.connect(this._onUserChanged, this);

    this._connect().catch(e => console.warn(e));
  }

  /**
   * Test whether the object has been disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Test whether the document is in read-only mode (locked by another user).
   */
  get isReadOnly(): boolean {
    return this._isReadOnly;
  }

  /**
   * Get the username of the user who has locked the file (if in read-only mode).
   */
  get lockedBy(): string | null {
    return this._lockedBy;
  }

  /**
   * A signal emitted when the read-only status changes.
   */
  get readOnlyChanged(): ISignal<this, boolean> {
    return this._readOnlyChanged;
  }

  /**
   * A promise that resolves when the document provider is ready.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  get contentType(): string {
    return this._contentType;
  }

  get format(): string {
    return this._format;
  }

  /**
   * Dispose of the resources held by the object.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._yWebsocketProvider?.off('connection-close', this._onConnectionClosed);
    this._yWebsocketProvider?.off('sync', this._onSync);
    this._yWebsocketProvider?.off('message', this._onMessage);
    this._yWebsocketProvider?.destroy();
    this._disconnect();
    Signal.clearData(this);
  }

  async reconnect(): Promise<void> {
    this._disconnect();
    this._connect();
  }

  private async _connect(): Promise<void> {
    let session;
    try {
      session = await requestDocSession(
        this._format,
        this._contentType,
        this._path
      );
    } catch (err) {
      const msg = messageFromResponseError(err);

      const isLocked =
        err instanceof ServerConnection.ResponseError &&
        err.response?.status === 423;

      if (isLocked) {
        void showFileLockError(msg);
      }

      try {
        this._onConnectionClosed?.({
          code: 423,
          reason: msg
        } as any);
      } catch {
        // best effort
      }

      // Re-throw so document open flow stops spinning
      throw err;
    }

    // Set read-only mode based on session response
    if (session.readOnly) {
      this._isReadOnly = true;
      this._lockedBy = session.lockedBy || null;
      this._readOnlyChanged.emit(true);
      console.log(`Document opened in read-only mode (locked by: ${this._lockedBy})`);
    }

    this._yWebsocketProvider = new YWebsocketProvider(
      this._serverUrl,
      `${session.format}:${session.type}:${session.fileId}`,
      this._sharedModel.ydoc,
      {
        disableBc: true,
        params: { sessionId: session.sessionId },
        awareness: this._awareness
      }
    );

    this._yWebsocketProvider.on('sync', this._onSync);
    this._yWebsocketProvider.on('connection-close', this._onConnectionClosed);
    this._yWebsocketProvider.on('message', this._onMessage);
  }

  async connectToForkDoc(forkRoomId: string, sessionId: string): Promise<void> {
    this._disconnect();
    this._yWebsocketProvider = new YWebsocketProvider(
      this._serverUrl,
      forkRoomId,
      this._sharedModel.ydoc,
      {
        disableBc: true,
        params: { sessionId },
        awareness: this._awareness
      }
    );
  }

  get wsProvider() {
    return this._yWebsocketProvider;
  }

  private _disconnect(): void {
    this._yWebsocketProvider?.off('connection-close', this._onConnectionClosed);
    this._yWebsocketProvider?.off('sync', this._onSync);
    this._yWebsocketProvider?.off('message', this._onMessage);
    this._yWebsocketProvider?.destroy();
    this._yWebsocketProvider = null;
  }

  private _onUserChanged(user: User.IManager): void {
    this._awareness.setLocalStateField('user', user.identity);
  }

  private _onMessage = (data: ArrayBuffer): void => {
    try {
      // Decode the message to check if it's a warning about read-only mode
      const decoder = new TextDecoder();
      const text = decoder.decode(data);

      // Try to parse as JSON (server sends JSON messages for warnings)
      try {
        const message = JSON.parse(text);
        if (message.type === 'warning' && message.readOnly) {
          console.warn('Read-only mode warning from server:', message.message);
          // Update read-only state if not already set
          if (!this._isReadOnly) {
            this._isReadOnly = true;
            this._readOnlyChanged.emit(true);
          }
        }
      } catch {
        // Not a JSON message, ignore
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  };

  private _onConnectionClosed = (event: any): void => {
    if (event.code === 1003) {
      console.error('Document provider closed:', event.reason);

      showErrorMessage(this._trans.__('Document session error'), event.reason, [
        Dialog.okButton()
      ]);

      // Dispose shared model immediately. Better break the document model,
      // than overriding data on disk.
      this._sharedModel.dispose();
    } else if (event.code === 423) {
      void showFileLockError(event.reason);
      this._sharedModel.dispose();
    }
  };

  private _onSync = (isSynced: boolean) => {
    if (isSynced) {
      if (this._yWebsocketProvider) {
        this._yWebsocketProvider.off('sync', this._onSync);

        const state = this._sharedModel.ydoc.getMap('state');
        state.set('document_id', this._yWebsocketProvider.roomname);
      }
      this._ready.resolve();
    }
  };

  private _awareness: Awareness;
  private _contentType: string;
  private _format: string;
  private _isDisposed: boolean;
  private _isReadOnly: boolean;
  private _lockedBy: string | null;
  private _path: string;
  private _ready = new PromiseDelegate<void>();
  private _readOnlyChanged: Signal<this, boolean>;
  private _serverUrl: string;
  private _sharedModel: YDocument<DocumentChange>;
  private _yWebsocketProvider: YWebsocketProvider | null;
  private _trans: TranslationBundle;
}

/**
 * A namespace for WebSocketProvider statics.
 */
export namespace WebSocketProvider {
  /**
   * The instantiation options for a WebSocketProvider.
   */
  export interface IOptions {
    /**
     * The server URL
     */
    url: string;

    /**
     * The document file path
     */
    path: string;

    /**
     * Content type
     */
    contentType: string;

    /**
     * The source format
     */
    format: string;

    /**
     * The shared model
     */
    model: YDocument<DocumentChange>;

    /**
     * The user data
     */
    user: User.IManager;

    /**
     * The jupyterlab translator
     */
    translator: TranslationBundle;
  }
}