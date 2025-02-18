import * as vscode from 'vscode';
import { logMessage } from '../extension';
import { IToolCall } from '../chat/chatHelpers';
import { Diagram } from '../diagram';
import { DiagramEditorPanel, ParseDetails, WebviewResources } from '../diagramEditorPanel';
import { DiagramDocument } from '../diagramDocument';
import { groqEnabled, callWithGroq as sendGroqRequest } from '../groqHandler';
import { checkForMermaidExtensions, formatMermaidErrorToNaturalLanguage } from '../mermaidHelpers';
import { PromptElementAndProps } from '@vscode/chat-extension-utils/dist/toolsPrompt';
import { OutlinePrompt } from './outlinePrompt';
import { sendChatParticipantRequest } from '@vscode/chat-extension-utils';

const followOutlineContextKey = 'copilot-mermAId-diagram.followActiveDocument';
const isShowingDiagramContextKey = 'copilot-mermAId-diagram.isShowingDiagram';
let outlineViewCancellationTokenSource: vscode.CancellationTokenSource | undefined;
let followActiveDocument = false;
let lastFocusedDocumentUri: vscode.Uri | undefined = undefined;


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
        vscode.commands.registerCommand('copilot-mermAId-diagram.refresh-outline', (documentUri: vscode.Uri) => {
            // Cancel the previous token if it exists
            if (outlineViewCancellationTokenSource) {
                outlineViewCancellationTokenSource.cancel();
            }

            if (!documentUri) {
                const visibleDocuments = vscode.window.visibleTextEditors;
                if (lastFocusedDocumentUri) {
                    documentUri = lastFocusedDocumentUri;
                } else if (visibleDocuments.length && visibleDocuments[0].document.uri.scheme === 'file') {
                    const visableDocumentUri = visibleDocuments[0].document.uri;
                    logMessage(`No active document so selecting first visible document: ${visableDocumentUri}`);
                    documentUri = visableDocumentUri;
                } else {
                    logMessage('No document found to refresh outline');
                    // warning
                    vscode.window.showWarningMessage('Focus a text file to generate an outline');
                    return;
                }
            }

            outlineViewCancellationTokenSource = new vscode.CancellationTokenSource();
            outlineView.generateOutlineDiagram(documentUri, outlineViewCancellationTokenSource.token);
        }),
        vscode.commands.registerCommand('copilot-mermAId-diagram.enable-follow-outline', () => {
            followActiveDocument = true;
            vscode.commands.executeCommand('setContext', followOutlineContextKey, true);
            // trigger a refresh on command to following the diagram
            const activeTextEditor = vscode.window.activeTextEditor;
            if (activeTextEditor && activeTextEditor.document?.uri?.scheme === 'file') {
                vscode.commands.executeCommand('copilot-mermAId-diagram.refresh-outline', activeTextEditor.document.uri);
            }

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
        vscode.commands.registerCommand('copilot-mermAId-diagram.continue-in-chat', async () => {
            await vscode.commands.executeCommand('workbench.action.chat.open');
            await vscode.commands.executeCommand('workbench.action.chat.sendToNewChat', { inputValue: '@mermAId /help' });
        }),
    );

    // Listen for active text editor change
    // Keep track of the last _valid_ active document in case the user
    // swaps to something like an output view (which also triggers this event)
    vscode.window.onDidChangeActiveTextEditor((e: vscode.TextEditor | undefined) => {
        if (!e) {
            logMessage('Active document changed to: none');
            return;
        }

        logMessage(`Active document changed to '${e.document?.fileName}' (scheme=${e.document?.uri?.scheme})`);
        if (e.document?.uri?.scheme === 'file') { // TODO: Be stricter?
            lastFocusedDocumentUri = e.document.uri;
            if (followActiveDocument) {
                logMessage('Refreshing outline diagram');
                vscode.commands.executeCommand('copilot-mermAId-diagram.refresh-outline', e.document.uri);
            }
        }
    });
}

class OutlineViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mermaid-outline-diagram';

    private _view?: vscode.WebviewView;
    private _webviewResources?: WebviewResources;
    private parseDetails: ParseDetails[] = [];
    private _diagram?: Diagram;

    public get diagram(): Diagram | undefined {
        return this._diagram;
    }

    public async generateOutlineDiagram(documentUri: vscode.Uri, cancellationToken: vscode.CancellationToken) {
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
                const { success } = await this.promptLLMToUpdateWebview(documentUri, cancellationToken);
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
            this.setContinueInChatPage();
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
                        await vscode.commands.executeCommand('copilot-mermAId-diagram.continue-in-chat');
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
                        this.parseDetails.push({
                            success: message.success ?? false,
                            error: message?.error,
                            nonce: message.nonce,
                            friendlyError
                        });
                        break;
                    default:
                        logMessage(`(Outline) Unhandled message: ${JSON.stringify(message)}`);
                }
            },
            null,
        );

        this.setLandingPage();
    }

    private async promptLLMToUpdateWebview(documentUri: vscode.Uri, cancellationToken: vscode.CancellationToken) {
        const doc = vscode.workspace.textDocuments.find(d => d.uri === documentUri);
        if (!doc || !this._view) {
            return { success: false, error: 'No document or view' };
        }

        const model = await this.getModel();
        if (!model) {
            return { success: false, error: 'No model' };
        }

        let localGroqEnabled = groqEnabled && vscode.workspace.getConfiguration('mermaid').get('groqEnabled') !== false;
        let retry = 0;
        let validationError = '';

        const runWithTools = async () => {
            const prompt: PromptElementAndProps<OutlinePrompt> = {
                promptElement: OutlinePrompt,
                props: { documentUri, validationError }
            };

            const request: vscode.ChatRequest = {
                model,
                prompt: "Create a diagram",
                references: [],
                toolReferences: [],
                command: undefined,
                toolInvocationToken: undefined as never
            };

            const context: vscode.ChatContext = {
                history: [],
            } 

            const result = sendChatParticipantRequest(
                request,
                context,
                {
                    prompt,
                    tools: vscode.lm.tools.filter(tool => 
                        tool.name === 'copilot_codebase' || tool.name === 'mermAId_get_symbol_definition'
                    ),
                    requestJustification: 'To display a dynamic diagram of the file outline',
                    extensionMode: this.context.extensionMode,
                },
                cancellationToken
            );

            let mermaidDiagram = '';
            for await (const part of result.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    mermaidDiagram += part.value;
                }
            }

            if (cancellationToken.isCancellationRequested) {
                return { success: false, error: 'Cancelled' };
            }

            logMessage(`Received candidate mermaid outline, moving to validation`);
            logMessage(mermaidDiagram);

            // Validate the diagram
            let candidateNextDiagram = undefined;
            if (mermaidDiagram.length === 0) {
                validationError = 'The diagram is empty, please retry';
                localGroqEnabled = false; // Disable GROQ as fallback
                return { success: false, error: 'Empty diagram' };
            }

            candidateNextDiagram = new Diagram(mermaidDiagram);
            const parseResult = await this.validate(candidateNextDiagram, cancellationToken);
            
            if (parseResult.success) {
                logMessage("Outline generation and validation success");
                return parseResult;
            }

            logMessage(`Outline generation not success (attempt=${++retry})`);
            if (retry < 4) {
                validationError = parseResult.friendlyError ?? parseResult.error;
                if (retry === 2) {
                    logMessage('Disabling groq for the third retry');
                    localGroqEnabled = false;
                }
                return runWithTools();
            }

            return { success: false, error: "Exhausted retries" };
        };

        return await runWithTools();
    }

    private async validate(candidateNextDiagram: Diagram, cancellationToken: vscode.CancellationToken): Promise<{ success: true } | { success: false, error: string; friendlyError?: string }> {
        if (cancellationToken.isCancellationRequested) {
            return { success: false, error: 'Cancelled' };
        }
        if (!this._view) {
            logMessage('FAIL! No view found - where did it go!');
            return { success: false, error: 'No view found. This is unexpected.' };
        }

        const nonce = new Date().getTime().toString();
        this._view.webview.html = DiagramEditorPanel.getHtmlToValidateMermaid(this._view.webview, candidateNextDiagram, nonce);
        // wait for parseDetails to be set via message posted from webview
        return new Promise<ParseDetails>((resolve) => {
            const interval = setInterval(() => {
                const pd = this.parseDetails.find((p) => p.nonce === nonce);
                if (pd) {
                    clearInterval(interval);
                    if (pd.success) {
                        if (!this._view) {
                            logMessage('FAIL! No view found - where did it go!');
                            return { success: false, error: 'No view found. This is unexpected.' };
                        }
                        if (cancellationToken.isCancellationRequested) {
                            return { success: false, error: 'Cancelled' };
                        }
                        this._view.webview.html = DiagramEditorPanel.getHtmlForWebview(this._view.webview, candidateNextDiagram);
                        this._diagram = candidateNextDiagram;
                        resolve(pd);
                    } else {
                        resolve(pd);
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
                <div style="display: flex; align-items: center;">
                    <i class="codicon codicon-comment-discussion"></i>
                    <span style="margin-left: 8px;">to start a chat session</span>
                </div>
            </div>
        `);
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
