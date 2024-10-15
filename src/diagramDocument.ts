import * as vscode from 'vscode';
import { Diagram } from './diagram';

export class DiagramDocument {
    public static documents: Set<vscode.Uri> = new Set<vscode.Uri>();

    public static async createAndShow(diagram: Diagram) {
        const diagramDoc = new DiagramDocument(diagram.content);
        const document = await diagramDoc.openDocument();
        DiagramDocument.documents.add(document.uri);
    }

    private documentPromise: Thenable<vscode.TextDocument>;

    private constructor(content: string) {
        this.documentPromise = vscode.workspace.openTextDocument({ language: 'markdown', content });

        const listener = vscode.workspace.onDidCloseTextDocument(async (doc) => {
            const uri = (await this.documentPromise).uri;
            if (doc.uri.toString() === uri.toString()) {
                DiagramDocument.documents.delete(uri);
                listener.dispose();
            }
        });
    }

    private async openDocument() {
        const document = await this.documentPromise;
        await vscode.window.showTextDocument(document);
        return document;
    }

}
