import * as vscode from 'vscode';
import { DiagramDocument } from './diagramDocument';
import { COMMAND_OPEN_DIAGRAM_SVG } from './commands';

export class CodelensProvider implements vscode.CodeLensProvider {

    private regex: RegExp = /```mermaid/;
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        if (DiagramDocument.documents.has(document.uri) && this.regex.test(document.lineAt(0).text)) {
            const range = document.lineAt(0).range;
            const codeLens = new vscode.CodeLens(range);
            return [codeLens];
        }
        return [];
    }

    public resolveCodeLens(codeLens: vscode.CodeLens, token: vscode.CancellationToken) {
        codeLens.command = {
            title: vscode.l10n.t("View rendered SVG"),
            command: COMMAND_OPEN_DIAGRAM_SVG
        };
        return codeLens;
    }
}