import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logMessage } from './extension';
import { exportMermaidSvg } from './mermaid';


const template = (innerContent: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=0.5">
    <title>Mermaid Outline Diagram</title>
</head>
<body>
    ${innerContent}
</body>
</html>
`;

const llmInstructions = `
You are helpful chat assistant that creates diagrams for the user using the mermaid syntax.
You will be provided a JSON object of code symbols in a document.
Use the data to create a diagram that represents the outline of the document.
Prefer taller diagrams instead of wider ones to make the diagram easier to read.
You must provide a valid mermaid diagram prefixed with a line containing  \`\`\`mermaid
and suffixed with a line containing \`\`\`.
Only ever include the \`\`\` delimiter in the two places mentioned above. 
Do not include any other text before or after the diagram, only include the diagram.
`;

export function registerOutlineView(context: vscode.ExtensionContext) {
    const outlineView = new OutlineViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            OutlineViewProvider.viewType,
            outlineView,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // TODO: update webview when underlying diagram changes.
    // vscode.workspace.createFileSystemWatcher
}

async function getActiveDocumentSymbols() {
    const activeTextEditor = vscode.window.activeTextEditor;
    if (activeTextEditor) {
        const symbols =
            await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                activeTextEditor.document.uri
            );
        logMessage(`Got ${symbols?.length} symbols for document ${activeTextEditor.document.uri}`);
        return symbols;
    }
}

export async function askLLMForFileOutlineDiagram(context: vscode.ExtensionContext) {
    const models = await vscode.lm.selectChatModels();
    if (!models.length) {
        logMessage('FAIL! No LLM model found');
        return;
    }

    const model = models.find(m => m.family === 'gpt-4o' && m.vendor === 'copilot');

    if (!model) {
        logMessage('FAIL! Preferred LLM model not found');
        return;
    }

    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'To display a dynamic diagram of the file outline',
    };

    const messages = [
        vscode.LanguageModelChatMessage.Assistant(llmInstructions),
    ];

    // Get symbols for the current document,
    // just like the outline pane would do
    const symbols = await getActiveDocumentSymbols();

    if (!symbols) { 
        throw new Error('No symbols found in the active document or no active document');
    }
    
    const symbolJson = JSON.stringify(symbols, null, 2);
    logMessage(symbolJson);
    messages.push(vscode.LanguageModelChatMessage.User(symbolJson));

    const response = await model.sendRequest(messages, options /*, cancellationToken */);

    let mermaidDiagram = '';
    for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
            mermaidDiagram += part.value;
        } else {
            logMessage('Received non-text part from LLM. Uh oh!!');
            throw new Error('Unimplemented non-text part');
        }
    }

    logMessage('Received outline diagram from LLM');
    logMessage(mermaidDiagram);

    // Write the diagram to a file
    try {
        await exportMermaidSvg(context.globalStorageUri.fsPath, mermaidDiagram);
    } catch (e) {
        logMessage(`Error exporting diagram for outline: ${e}`);
    }
}

class OutlineViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mermaid-outline-diagram';

    private _view?: vscode.WebviewView;

    public async resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken): Promise<void> {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
        };

        try {
            await askLLMForFileOutlineDiagram(this.context);
        } catch (e) {
            logMessage(`Error getting outline diagram from LLM: ${e}`);
        }

        const svgPath = path.join(this.context.globalStorageUri.fsPath, 'diagram-1.svg');
        let svgContents: string;
        try {
            svgContents = await fs.readFile(svgPath, { encoding: 'utf8' });
        } catch (e) {
            webviewView.webview.html = template('<p>No diagram</p>');
            return;
        }

        webviewView.webview.html = template(svgContents);
    }

    constructor(private readonly context: vscode.ExtensionContext) { }

}

