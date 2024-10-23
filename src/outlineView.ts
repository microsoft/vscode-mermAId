import * as vscode from 'vscode';
import { logMessage } from './extension';
import { IToolCall } from './chat/chatHelpers';
import { Diagram } from './diagram';
import { DiagramEditorPanel, WebviewResources } from './diagramEditorPanel';
import { DiagramDocument } from './diagramDocument';
import { groqEnabled, callWithGroq as sendGroqRequest } from './groqHandler';
import { checkForMermaidExtensions, formatMermaidErrorToNaturalLanguage } from './mermaidHelpers';

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
const followOutlineContextKey = 'copilot-mermAId-diagram.followActiveDocument';
const isShowingDiagramContextKey = 'copilot-mermAId-diagram.isShowingDiagram';

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
        }),
        vscode.commands.registerCommand('copilot-mermAId-diagram.enable-follow-outline', () => {
            followActiveDocument = true;
            vscode.commands.executeCommand('setContext', followOutlineContextKey, true);
            // trigger a refresh on command to following the diagram
            vscode.commands.executeCommand('copilot-mermAId-diagram.refresh-outline');

        }),
        vscode.commands.registerCommand('copilot-mermAId-diagram.disable-follow-outline', () => {
            followActiveDocument = false;
            vscode.commands.executeCommand('setContext', followOutlineContextKey, false);
        }),
        vscode.commands.registerCommand('copilot-mermAId-diagram.view-markdown-source-from-outline', async () => {
            if (!outlineView.diagram) {
                logMessage('No diagram found to show source');
                return;
            }
            await DiagramDocument.createAndShow(outlineView.diagram);
        }),
        vscode.commands.registerCommand('copilot-mermAId-diagram.open-in-window-from-outline', async () => {
            if (!outlineView.diagram) {
                logMessage('No diagram found to open in window');
                return;
            }
            await DiagramEditorPanel.createOrShow(outlineView.diagram);
        }),
    );

    // Listen for active text editor change
    vscode.window.onDidChangeActiveTextEditor((e: vscode.TextEditor | undefined) => {
        if (!e) {
            logMessage('Active document changed to: none');
            return;
        }
        logMessage(`Active document changed to: ${e.document?.fileName} (scheme=${e.document?.uri?.scheme})`);
        if (followActiveDocument && e.document?.uri?.scheme === 'file') {
            logMessage('Refreshing outline diagram');
            vscode.commands.executeCommand('copilot-mermAId-diagram.refresh-outline');
        }
    });
}

class OutlineViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mermaid-outline-diagram';

    private _view?: vscode.WebviewView;
    private _webviewResources?: WebviewResources;
    private parseDetails: { success: true } | { success: false; error: string; friendlyError?: string } | undefined = undefined;
    private _diagram?: Diagram;

    public get diagram(): Diagram | undefined {
        return this._diagram;
    }

    public async generateOutlineDiagram(cancellationToken: vscode.CancellationToken) {
        if (!this._view) {
            return;
        }
        logMessage('Generating outline diagram...');
        try {
            vscode.window.withProgress({
                location: { viewId: 'mermaid-outline-diagram' },
                cancellable: false,
                title: 'Generating outline diagram',
            }, async (progress, _) => {
                this.setGeneratingPage();
                const { success } = await this.promptLLMToUpdateWebview(cancellationToken);
                if (cancellationToken.isCancellationRequested) {
                    logMessage('Cancellation requested, not updating webview');
                    return;
                }
                if (success) {
                    vscode.commands.executeCommand('setContext', isShowingDiagramContextKey, true);
                } else {
                    logMessage(`Error generating outline diagram from LLM`);
                    this.setContinueInChatPage();
                }
            });
        } catch (e) {
            logMessage(`UNHANDLED error generating outline diagram (cancelled=${cancellationToken.isCancellationRequested}): ${e}`);
            if (e instanceof Error && e.message.includes("Invalid API Key")) {
                vscode.window.showErrorMessage(`Invalid API Key for GROQ`);
            }
        }
    }

    public async resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken): Promise<void> {
        this._view = webviewView;
        this._webviewResources = DiagramEditorPanel.getWebviewResources(this._view.webview);

        webviewView.webview.options = {
            enableScripts: true,
        };

        this._view.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'continue-in-chat':
                        logMessage('Continuing in chat from outline view...');
                        await vscode.commands.executeCommand('workbench.action.chat.open');
                        await vscode.commands.executeCommand('workbench.action.chat.sendToNewChat', { inputValue: '@mermAId /help' });
                        this.setLandingPage();
                        break;
                    case 'mermaid-source':
                        if (!this._diagram) {
                            logMessage('UNEXPECTED: No diagram found to show source');
                            return;
                        }
                        await DiagramDocument.createAndShow(this._diagram);
                        checkForMermaidExtensions();
                        break;
                    case 'parse-result':
                        logMessage(`(Outline) Parse Result: ${JSON.stringify(message)}`);
                        const friendlyError: string | undefined = formatMermaidErrorToNaturalLanguage(message);
                        // Setting this field will move state forward
                        this.parseDetails = {
                            success: message.success ?? false,
                            error: message?.error,
                            friendlyError
                        };
                        break;
                    default:
                        logMessage(`(Outline) Unhandled message: ${JSON.stringify(message)}`);
                }
            },
            null,
        );

        this.setLandingPage();
    }

    private async promptLLMToUpdateWebview(cancellationToken: vscode.CancellationToken) {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc || !this._view) {
            return { success: false, error: 'No document or view' };
        }

        const model = await this.getModel();
        if (!model) {
            return { success: false, error: 'No model' };
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
        logMessage(`Available tools: ${options.tools?.map(tool => tool.name)?.join(', ')}`);
        if (cancellationToken.isCancellationRequested) {
            return { success: false, error: 'Cancelled' };
        }

        const messages = [
            vscode.LanguageModelChatMessage.Assistant(llmInstructions),
            vscode.LanguageModelChatMessage.User(`The file the user currently has open is: ${doc.uri.fsPath} with contents: ${doc.getText()}`),
        ];

        // A flag to enable groq if API key is present      
        let localGroqEnabled = groqEnabled;
        if (groqEnabled) {
            // If api key is present, also check the setting
            const setting = vscode.workspace.getConfiguration('mermaid').get('groqEnabled');
            if (setting === false) {
                // if setting turns off groq, do so in extension
                localGroqEnabled = false;
            }
            // otherwise keep it on
        }

        // Recursive
        let retries = 0;
        const runWithTools = async () => {
            const toolCalls: IToolCall[] = [];
            let mermaidDiagram = '';

            if (cancellationToken.isCancellationRequested) {
                return { success: false, error: 'Cancelled' };
            }

            let response;
            if (localGroqEnabled) {
                response = await sendGroqRequest(messages);
            } else {
                response = await model.sendRequest(messages, options, cancellationToken);
            }
            // Loop for reading response from the LLM
            for await (let part of response.stream) {
                if (part !== null && 'choices' in (part as any)) {
                    // This is a hack to get around Groq return style and convert it the desired shape
                    try {
                        const justDelta = (part as any).choices[0]?.delta;
                        const toolCall = (part as any).choices[0]?.delta?.tool_calls;
                        const partContent: string = (part as any).choices[0]?.delta?.content;
                        if (partContent) {
                            // do not translate if undefined
                            part = new vscode.LanguageModelTextPart(partContent);
                        }
                        if (toolCall) {
                            // translate tool call to a tool call object
                            const args = toolCall[0].function.arguments;
                            const argsParsed = JSON.parse(toolCall[0].function.arguments);
                            // groq only has one tool, so we can hardcode the name
                            const toolName = "mermAId_get_symbol_definition";
                            const id = toolCall[0].id;
                            part = new vscode.LanguageModelToolCallPart(toolName, id, argsParsed);
                        }

                    } catch (e) {
                        logMessage(`ERR: ${e}`);
                        console.log(e);
                    }
                }
                if (part instanceof vscode.LanguageModelTextPart) {
                    mermaidDiagram += part.value;
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    const toolUsed = vscode.lm.tools.find(t => t.name === part.name);
                    logMessage(`🛠️ Used tool '${toolUsed?.name}' to generate diagram`);
                    if (!toolUsed) {
                        throw new Error(`Tool ${part.name} invalid`);
                    }
                    const parameters = part.parameters;

                    toolCalls.push({
                        call: part,
                        result: vscode.lm.invokeTool(toolUsed.name,
                            {
                                parameters,
                                toolInvocationToken: undefined,
                            }, cancellationToken),
                        tool: toolUsed
                    });
                }

                // if any tools were used, add them to the context and re-run the query
                if (toolCalls.length) {
                    const assistantMsg = vscode.LanguageModelChatMessage.Assistant('');
                    assistantMsg.content2 = toolCalls.map(toolCall => new vscode.LanguageModelToolCallPart(toolCall.tool.name, toolCall.call.callId, toolCall.call.parameters));
                    messages.push(assistantMsg);
                    for (const toolCall of toolCalls) {
                        // NOTE that the result of calling a function is a special content type of a USER-message
                        const message = vscode.LanguageModelChatMessage.User('');
                        const tooolResult = await toolCall.result;
                        message.content2 = [new vscode.LanguageModelToolResultPart(toolCall.call.callId, [tooolResult])];
                        messages.push(message);
                    }

                    // IMPORTANT The prompt must end with a USER message (with no tool call)
                    messages.push(vscode.LanguageModelChatMessage.User(`Above is the result of calling the functions ${toolCalls.map(call => call.tool.name)?.join(', ')}. Use this as you iterate on the mermaid diagram.`));

                    // RE-enter
                    return runWithTools();
                }
            } // done with stream loop

            logMessage(`Received candidate mermaid outline, moving to validation, for file: ${mermaidDiagram}`);
            logMessage(mermaidDiagram);

            // Validate the diagram
            let result: { success: true } | { success: false, error: string; friendlyError?: string } | undefined = undefined;
            let candidateNextDiagram = undefined;
            if (mermaidDiagram.length === 0) {
                // Diagram isn't valid if it is empty, no need to try and parse it, give better error back to model
                result = { success: false, error: "Empty diagram" };
                messages.push(vscode.LanguageModelChatMessage.User(`The diagram is empty, please retry`));
                // this may occur if groq reached max tokens, so disable groq as a fallback
                localGroqEnabled = false;
                messages.push(vscode.LanguageModelChatMessage.User(`diagram returned was empty (turning off groq if on)`));
            } else {
                candidateNextDiagram = new Diagram(mermaidDiagram);
                result = await this.validate(candidateNextDiagram, cancellationToken);
            }


            if (result.success) {
                logMessage("Outline generation and validation success");
                return result;
            }

            //  -- Handle parse error

            logMessage(`Outline generation not success (on retry ${++retries})`); // seen some with diagram = ```
            if (retries < 4) {

                // --- Try to manually fix

                // TODO: 
                //     Below is commented because calling this.validate is causing a race (due to how it sets this.parseDetails)
                //
                // check for inner braces error, remove if exists
                // const regex = /\{[^{}]*\{[^{}]*\}[^{}]*\}/g;
                // const regexMatches = mermaidDiagram.match(regex);
                // if (regexMatches?.length && regexMatches.length > 0) {
                //     logMessage(`Removing inner braces from diagram....`);
                //     const diagram = removeInnerBracesAndContent(mermaidDiagram);
                //     const candidateNextDiagram2 = new Diagram(diagram);
                //     const { success } = await this.validate(candidateNextDiagram2, cancellationToken);
                //     if (success) {
                //         logMessage("(Inner brace check) Outline generation and validation success");
                //         return result;
                //     }
                // }

                // -- Prompt LLM to fix

                messages.push(
                    vscode.LanguageModelChatMessage.User(`Please fix mermaid parse errors to make the diagram render correctly.`)
                );

                if (result.friendlyError) {
                    messages.push(
                        vscode.LanguageModelChatMessage.User(result.friendlyError)
                    );
                }

                messages.push(
                    vscode.LanguageModelChatMessage.User(
                        `The raw error reported is: ${result.error}`
                    )
                );

                if (candidateNextDiagram) {
                    messages.push(
                        vscode.LanguageModelChatMessage.User(`The produced diagram with the parse error is:\n${candidateNextDiagram.content}`)
                    );
                }

                if (retries === 2) {
                    // Disable groq for the third retry since OpenAI can be more dependable
                    logMessage('Disabling groq for the third retry');
                    localGroqEnabled = false;
                }
                return runWithTools();
            } else {
                return { success: false, error: "Exhausted retries" };
            }
        }; // done with runWithTools

        return await runWithTools();
    }

    private async validate(candidateNextDiagram: Diagram, cancellationToken: vscode.CancellationToken): Promise<{ success: true } | { success: false, error: string; friendlyError?: string }> {
        if (cancellationToken.isCancellationRequested) {
            return { success: false, error: 'Cancelled' };
        }
        this.parseDetails = undefined; // TODO: This feels race-y.
        if (!this._view) {
            logMessage('FAIL! No view found - where did it go!');
            return { success: false, error: 'No view found. This is unexpected.' };
        }
        this._view.webview.html = DiagramEditorPanel.getHtmlToValidateMermaid(this._view.webview, candidateNextDiagram);
        // wait for parseDetails to be set via message posted from webview
        return new Promise<{ success: true } | { success: false; error: string; friendlyError?: string }>((resolve) => {
            const interval = setInterval(() => {
                if (this.parseDetails !== undefined) {
                    clearInterval(interval);
                    if (this.parseDetails.success) {
                        if (!this._view) {
                            logMessage('FAIL! No view found - where did it go!');
                            return { success: false, error: 'No view found. This is unexpected.' };
                        }
                        if (cancellationToken.isCancellationRequested) {
                            return { success: false, error: 'Cancelled' };
                        }
                        this._view.webview.html = DiagramEditorPanel.getHtmlForWebview(this._view.webview, candidateNextDiagram);
                        this._diagram = candidateNextDiagram;
                        resolve({ success: true });
                    } else {
                        resolve({ success: false, error: this.parseDetails.error });
                    }
                }
            }, 100);
        });
    }

    private async getModel(): Promise<vscode.LanguageModelChat | undefined> {
        const models = await vscode.lm.selectChatModels();
        if (!models.length) {
            logMessage('FAIL! No LLM model found');
            return;
        }
        const model = models.find(m => m.family === 'gpt-4o' && m.vendor === 'copilot'); // TODO: Hardcoding to avoid a bug with selector object
        if (!model) {
            logMessage('FAIL! Preferred LLM model not found');
            return;
        }
        return model;
    }

    private template(innerHtmlContent: string, styleCssContent?: string) {
        const { codiconsUri } = this._webviewResources!; // TODO: Assumes caller has already confirmed this is set
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=0.5">
                <link href="${codiconsUri}" rel="stylesheet">
                <title>MermAId Outline Diagram</title>
                <style>
                    ${styleCssContent}
                </style>
            </head>
            <body>
                ${innerHtmlContent}
            </body>
            </html>
        `;
    }

    private setGeneratingPage() {
        vscode.commands.executeCommand('setContext', isShowingDiagramContextKey, false);
        if (!this._view || !this._webviewResources) {
            logMessage('ERR: No view or webview resources found');
            return;
        }
        const { animatedGraphUri } = this._webviewResources;
        this._view.webview.html = this.template(`
            <img src="${animatedGraphUri}" alt="Loading image">
        `, `
        body {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
        }`);
    }

    private setLandingPage() {
        vscode.commands.executeCommand('setContext', isShowingDiagramContextKey, false);
        if (!this._view || !this._webviewResources) {
            logMessage('ERR: No view or webview resources found');
            return;
        }
        this._view.webview.html = this.template(`
            <div style="text-align: center; margin-top:20px">
                <i class="codicon codicon-type-hierarchy-sub" style="font-size: 48px;"></i>
            </div>
            <h1 style="text-align: center; font-weight: bold;">MermAId Outline</h1>
            <p style="text-align: center;">Generate a Mermaid diagram of the active document, powered by Copilot.</p>

            <div style="display: flex; justify-content: center; padding-top: 5px">
            <div style="display: flex; flex-direction: column; align-items: flex-start; gap: 16px;">
                <div style="display: flex; align-items: center; padding-bottom: 0px">
                    <i class="codicon codicon-refresh"></i>
                    <span style="margin-left: 8px;">to regenerate</span>
                </div>
                <div style="display: flex; align-items: center;">
                    <i class="codicon codicon-pin"></i>
                    <span style="margin-left: 8px;">to follow the active document</span>
                </div>
                </div>
            </div>
        `); // TODO: Style, Add buttons?
    }

    private setContinueInChatPage() {
        vscode.commands.executeCommand('setContext', isShowingDiagramContextKey, false);
        if (!this._view || !this._webviewResources) {
            logMessage('ERR: No view or webview resources found');
            return;
        }
        this._view.webview.html = this.template(`
            <script type="module">
            const vscode = acquireVsCodeApi();
            document.getElementById('continue-in-chat-link').addEventListener('click', () => {
            vscode.postMessage({ command: 'continue-in-chat' });
            });
            </script>
            <div style="display: flex; justify-content: center; align-items: center; padding: 20px; text-align: center;">
            <p> For large files and complex diagrams, <a id="continue-in-chat-link" class="vscode-link" href="#">continue in chat</a>.
            </div>
        `,
            `
        body {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
        }
        .vscode-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            cursor: pointer;
        }
        .vscode-link:hover {
            text-decoration: underline;
        }`);
    }

    constructor(private readonly context: vscode.ExtensionContext) { }

}

function removeInnerBracesAndContent(str: string) {
    // Match the pattern of double nested curly braces and their contents
    const regex = /\{[^{}]*\{[^{}]*\}[^{}]*\}/g;

    // Replace the entire match with an empty string, effectively removing it
    return str.replace(regex, '');
}

