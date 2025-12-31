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

        const setupWidget = (widget: IDocumentWidget) => {
            const context = widget.context;
            context.ready.then(() => {
                const docId = (context.model.sharedModel as any).getState?.('document_id') as string;

                if (docId) {
                    const [format, type] = docId.split(':');
                    const key = `${format}:${type}:${context.path}`;
                    const provider = contentProvider.providers.get(key);
                    if (provider) {
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
