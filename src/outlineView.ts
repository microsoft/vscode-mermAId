import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logMessage } from './extension';
import { IToolCall } from './chat/chatHelpers';
import { Diagram } from './diagram';
import { DiagramEditorPanel } from './diagramEditorPanel';


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
The output diagram should represent an outline of the document.
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

// async function getActiveDocumentSymbols() {
//     const activeTextEditor = vscode.window.activeTextEditor;
//     if (activeTextEditor) {
//         const symbols =
//             await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
//                 'vscode.executeDocumentSymbolProvider',
//                 activeTextEditor.document.uri
//             );
//         logMessage(`Got ${symbols?.length} symbols for document ${activeTextEditor.document.uri}`);
//         return symbols;
//     }
// }

export async function promptLLMForOutlineDiagram(context: vscode.ExtensionContext, cancellationToken: vscode.CancellationToken): Promise<Diagram | undefined> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) {
        return;
    }

    const models = await vscode.lm.selectChatModels();
    if (!models.length) {
        logMessage('FAIL! No LLM model found');
        return;
    }
    const model = models.find(m => m.family === 'gpt-4o' && m.vendor === 'copilot'); // TODO:
    if (!model) {
        logMessage('FAIL! Preferred LLM model not found');
        return;
    }

    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'To display a dynamic diagram of the file outline',
        tools: vscode.lm.tools.map((tool): vscode.LanguageModelChatTool => {
            return {
                name: tool.id,
                description: tool.description,
                parametersSchema: tool.parametersSchema ?? {}
            };
        }),
    };
    logMessage(`Available tools: ${options.tools?.map(tool => tool.name).join(', ')}`);


    const messages = [
        vscode.LanguageModelChatMessage.Assistant(llmInstructions),
        vscode.LanguageModelChatMessage.User(`The file the user currently has open is: ${doc.uri.fsPath} with contents: ${doc.getText()}`),
    ];

    // Recursive
    let retries = 0;
    const runWithTools = async (): Promise<Diagram | undefined> => {
        const toolCalls: IToolCall[] = [];
        let mermaidDiagram = '';

        const response = await model.sendRequest(messages, options, cancellationToken);
        // Loop for reading response from the LLM
        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                mermaidDiagram += part.value;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                const toolUsed = vscode.lm.tools.find(t => t.id === part.name);
                logMessage(`🛠️ Used tool '${toolUsed?.id}' to generate diagram`);
                if (!toolUsed) {
                    throw new Error(`Tool ${part.name} invalid`);
                }
                let parameters: any;
                try {
                    parameters = JSON.parse(part.parameters);
                } catch (err) {
                    throw new Error(`Got invalid tool use parameters: "${part.parameters}". (${(err as Error).message})`);
                }

                const requestedContentType = 'text/plain';
                toolCalls.push({
                    call: part,
                    result: vscode.lm.invokeTool(toolUsed.id,
                        {
                            parameters,
                            toolInvocationToken: undefined,
                            requestedContentTypes: [requestedContentType]
                        }, cancellationToken),
                    tool: toolUsed
                });
            }

            // if any tools were used, add them to the context and re-run the query
            if (toolCalls.length) {
                const assistantMsg = vscode.LanguageModelChatMessage.Assistant('');
                assistantMsg.content2 = toolCalls.map(toolCall => new vscode.LanguageModelToolCallPart(toolCall.tool.id, toolCall.call.toolCallId, toolCall.call.parameters));
                messages.push(assistantMsg);
                for (const toolCall of toolCalls) {
                    // NOTE that the result of calling a function is a special content type of a USER-message
                    const message = vscode.LanguageModelChatMessage.User('');
                    message.content2 = [new vscode.LanguageModelToolResultPart(toolCall.call.toolCallId, (await toolCall.result)['text/plain']!)];
                    messages.push(message);
                }

                // IMPORTANT The prompt must end with a USER message (with no tool call)
                messages.push(vscode.LanguageModelChatMessage.User(`Above is the result of calling the functions ${toolCalls.map(call => call.tool.id).join(', ')}. Use this as you iterate on the mermaid diagram.`));

                // RE-enter
                return runWithTools();
            }
        } // done with stream loop

        logMessage(`Received candidate mermaid outline for file: ${mermaidDiagram}`);
        logMessage(mermaidDiagram);

        // Validate the diagram
        const nextDiagram = new Diagram(mermaidDiagram);
        const result = await nextDiagram.generateWithValidation();
        if (!result.success) {
            logMessage(`Candidate failed failidation (retries=${retries}): ${result.message}`);
            if (retries++ < 2) {
                logMessage(`Retrying...`);
                messages.push(vscode.LanguageModelChatMessage.User(`Please fix this error to make the diagram render correctly: ${result.message}. The diagram is below:\n${mermaidDiagram}`));
                return runWithTools();

            }
        }
        return nextDiagram;
    };

    return await runWithTools();
}

class OutlineViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mermaid-outline-diagram';

    private _view?: vscode.WebviewView;
    private diagram?: Diagram;

    private async _generateOutlineDiagram() {
        const cancellationTokenSource = new vscode.CancellationTokenSource(); // TODO: Use me
        try {
            logMessage('Generating outline diagram...');
            const nextDiagram: Diagram | undefined = await promptLLMForOutlineDiagram(this.context, cancellationTokenSource.token);

            if (nextDiagram) {
                this.diagram = nextDiagram;
                this._setOutlineDiagram();
            }

        } catch (e) {
            logMessage(`Error getting outline diagram from LLM: ${e}`);
        }
    }

    private async _setOutlineDiagram() {
        if (!this._view) {
            return;
        }

        try {
            const svgContents = this.diagram?.asSvg;
            if (!svgContents || !svgContents.length) {
                this._view.webview.html = template('<p>Empty diagram</p>');
                return;
            }
            this._view.webview.html = DiagramEditorPanel.getHtmlForWebview(this._view.webview, svgContents);
        } catch (e) {
            this._view.webview.html = template('<p>No diagram</p>');
            return;
        }
    }

    public async resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken): Promise<void> {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
        };

        await this._generateOutlineDiagram();
        this._setOutlineDiagram();
    }

    constructor(private readonly context: vscode.ExtensionContext) { }

}
