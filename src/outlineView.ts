import * as vscode from 'vscode';
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
Use tools to help you formulate the structure of the code.
You must provide a valid mermaid diagram prefixed with a line containing  \`\`\`mermaid
and suffixed with a line containing \`\`\`.
Only ever include the \`\`\` delimiter in the two places mentioned above.
Do not include any other text before or after the diagram, only include the diagram.
`;

let outlineViewCancellationTokenSource: vscode.CancellationTokenSource | undefined;

let followActiveDocument = false;

export function registerOutlineView(context: vscode.ExtensionContext) {
    const outlineView = new OutlineViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            OutlineViewProvider.viewType,
            outlineView,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('copilot-mermAId-diagram.refresh-outline', () => {
            // Cancel the previous token if it exists
            if (outlineViewCancellationTokenSource) {
                outlineViewCancellationTokenSource.cancel();
            }
            outlineViewCancellationTokenSource = new vscode.CancellationTokenSource();
            outlineView.generateOutlineDiagram(outlineViewCancellationTokenSource.token);
        })
    );

    // When enabled, toggle automatically updating
    // outline whenever focused document changes
    context.subscriptions.push(
        vscode.commands.registerCommand('copilot-mermAId-diagram.follow-outline', () => {
            followActiveDocument = !followActiveDocument;
            vscode.window.showInformationMessage(`Follow ${followActiveDocument ? 'enabled' : 'disabled'}`);
        })
    );

    // Listen for active text editor change
    vscode.window.onDidChangeActiveTextEditor((e: vscode.TextEditor | undefined) => {
        if (followActiveDocument) {
            logMessage(`Active document changed to: ${e?.document.fileName}`);
            vscode.commands.executeCommand('copilot-mermAId-diagram.refresh-outline');
        }
    });

    // TODO: update webview when underlying diagram changes.
    // vscode.workspace.createFileSystemWatcher
}

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
                name: tool.name,
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

        if (cancellationToken.isCancellationRequested) {
            return;
        }

        const response = await model.sendRequest(messages, options, cancellationToken);
        // Loop for reading response from the LLM
        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                mermaidDiagram += part.value;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                const toolUsed = vscode.lm.tools.find(t => t.name === part.name);
                logMessage(`🛠️ Used tool '${toolUsed?.name}' to generate diagram`);
                if (!toolUsed) {
                    throw new Error(`Tool ${part.name} invalid`);
                }
                const parameters = part.parameters;

                const requestedContentType = 'text/plain';
                toolCalls.push({
                    call: part,
                    result: vscode.lm.invokeTool(toolUsed.name,
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
                assistantMsg.content2 = toolCalls.map(toolCall => new vscode.LanguageModelToolCallPart(toolCall.tool.name, toolCall.call.toolCallId, toolCall.call.parameters));
                messages.push(assistantMsg);
                for (const toolCall of toolCalls) {
                    // NOTE that the result of calling a function is a special content type of a USER-message
                    const message = vscode.LanguageModelChatMessage.User('');
                    message.content2 = [new vscode.LanguageModelToolResultPart(toolCall.call.toolCallId, (await toolCall.result)['text/plain']!)];
                    messages.push(message);
                }

                // IMPORTANT The prompt must end with a USER message (with no tool call)
                messages.push(vscode.LanguageModelChatMessage.User(`Above is the result of calling the functions ${toolCalls.map(call => call.tool.name).join(', ')}. Use this as you iterate on the mermaid diagram.`));

                // RE-enter
                return runWithTools();
            }
        } // done with stream loop

        logMessage(`Received candidate mermaid outline for file: ${mermaidDiagram}`);
        logMessage(mermaidDiagram);

        // Validate the diagram
        const nextDiagram = new Diagram(mermaidDiagram);
        return nextDiagram;

        // jospicer TODO: Needs to add back validation here.
    };

    return await runWithTools();
}

class OutlineViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mermaid-outline-diagram';

    private _view?: vscode.WebviewView;
    private diagram?: Diagram;

    public async generateOutlineDiagram(cancellationToken: vscode.CancellationToken) {
        await this.setLoadingMessage();
        try {
            logMessage('Generating outline diagram...');
            const nextDiagram: Diagram | undefined = await promptLLMForOutlineDiagram(this.context, cancellationToken);

            if (nextDiagram) {
                this.diagram = nextDiagram;
                this._setOutlineDiagram();
            }

        } catch (e) {
            logMessage(`Error getting outline diagram from LLM: ${e}`);
            this.setTryAgainMessage();
        }
    }

    private setLoadingMessage() {
        if (!this._view) {
            return;
        }
        this._view.webview.html = template('<p>Generating...</p>');
    }

    private setTryAgainMessage() {
        if (!this._view) {
            return;
        }
        this._view.webview.html = template('<p>Please try again.</p>');
    }

    private async _setOutlineDiagram() {
        if (!this._view) {
            return;
        }

        if (!this.diagram) {
            this._view.webview.html = template('<p>Refresh to generate diagram</p>');
            return;
        }

        try {
            const mermaidMd = this.diagram.content;
            if (!mermaidMd || !mermaidMd.length) {
                this._view.webview.html = template('<p>Empty diagram</p>');
                return;
            }
            this._view.webview.html = DiagramEditorPanel.getHtmlForWebview(this._view.webview, mermaidMd, false);
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
        this._setOutlineDiagram();
    }

    constructor(private readonly context: vscode.ExtensionContext) { }

}
