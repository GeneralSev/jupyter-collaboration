/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import {
    JupyterFrontEnd,
    JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
    ICollaborativeContentProvider,
    IDocumentProvider
} from '@jupyter/collaborative-drive';
import { IEditorTracker } from '@jupyterlab/fileeditor';
import { INotebookTracker } from '@jupyterlab/notebook';
import { createReadonlyLabel, IDocumentWidget } from '@jupyterlab/docregistry';
import { ITranslator } from '@jupyterlab/translation';
import { Widget } from '@lumino/widgets';

/**
 * A plugin to add a read-only indicator to the toolbar.
 */
export const readOnlyIndicator: JupyterFrontEndPlugin<void> = {
    id: '@jupyter/docprovider-extension:readOnlyIndicator',
    description: 'Plugin to add a read-only indicator to the toolbar',
    autoStart: true,
    requires: [ICollaborativeContentProvider, ITranslator],
    optional: [IEditorTracker, INotebookTracker],
    activate: (
        app: JupyterFrontEnd,
        contentProvider: ICollaborativeContentProvider,
        translator: ITranslator,
        editorTracker: IEditorTracker | null,
        notebookTracker: INotebookTracker | null
    ): void => {

        // Better pattern: Controller class? Or just closure with explicit disconnect.
        const setupWidget = (widget: IDocumentWidget) => {
            // Find provider
            const context = widget.context;
            // The provider is linked via file path.
            // We can look it up in contentProvider.
            // We need the key: format:type:path
            // context.model.sharedModel ....
            // We can wait for context.ready?

            context.ready.then(() => {
                // How to get provider key?
                // In ydrive.ts/RtcContentProvider, key is `${format}:${type}:${path}`.

                // We can try to construct it.
                // But we don't know format easily from outside?
                // context.model.sharedModel might have it but it's YDocument.

                // Actually, we can iterate providers and match path?
                // Or contentProvider.providers is a Map.

                // Let's use what we know from existing code.
                // RtcContentProvider has private _providers.
                // But ICollaborativeContentProvider interface exposes `providers`.

                // We need to construct the key.
                // format and type.
                // In DocRegistry, we don't always know exact format (base64 vs text).
                // But for text/notebook it is consistent.

                // Let's use `context.model.sharedModel.getState('document_id')`? 
                // In component.tsx, `statusBarTimeline` uses:
                // currentWidget.context.model.sharedModel.getState('document_id')
                // This seems promising!

                const docId = (context.model.sharedModel as any).getState?.('document_id') as string;
                // But 'document_id' is set in yprovider.ts:260: `state.set('document_id', this._yWebsocketProvider.roomname);`
                // Roomname is usually the document ID used by Yjs?
                // No, in `yprovider` constructor: `roomname` is `${session.format}:${session.type}:${session.fileId}`. (line 168)
                // But the keys in `providers` map are `${options.format}:${options.contentType}:${path}` (line 270 of ydrive).

                // Wait. The keys in providers map use PATH.
                // The roomname has FILEID.
                // They are different.

                // BUT, `statusBarTimeline` does this:
                // const [format, type] = documentId.split(':');
                // const provider = contentProvider.providers.get(`${format}:${type}:${documentPath}`);

                // So we can extract format and type from documentId, and append path.

                if (docId) {
                    const [format, type] = docId.split(':');
                    const key = `${format}:${type}:${context.path}`;
                    const provider = contentProvider.providers.get(key);
                    if (provider) {
                        // Logic to update read only
                        let isReadOnly = (provider as any).isReadOnly;
                        let labelWidget: Widget | null = null;

                        const update = (ro: boolean) => {
                            if (ro) {
                                if (!labelWidget || !labelWidget.isAttached) {
                                    labelWidget = createReadonlyLabel(widget, translator);
                                    widget.toolbar.insertBefore('kernelName', 'read-only-indicator', labelWidget);
                                }
                            } else {
                                if (labelWidget) {
                                    labelWidget.dispose();
                                    labelWidget = null;
                                }
                            }
                        };

                        update(isReadOnly);

                        const onReadOnlyChanged = (_: any, ro: boolean) => {
                            update(ro);
                        };

                        (provider as any).readOnlyChanged?.connect(onReadOnlyChanged);

                        widget.disposed.connect(() => {
                            (provider as any).readOnlyChanged?.disconnect(onReadOnlyChanged);
                        });
                    }
                }
            });
        };

        if (editorTracker) {
            editorTracker.widgetAdded.connect((_, widget) => setupWidget(widget));
        }
        if (notebookTracker) {
            notebookTracker.widgetAdded.connect((_, widget) => setupWidget(widget));
        }
    }
};
