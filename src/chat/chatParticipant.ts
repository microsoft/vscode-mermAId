import { sendChatParticipantRequest } from '@vscode/chat-extension-utils';
import { PromptElementAndProps } from '@vscode/chat-extension-utils/dist/toolsPrompt';
import * as vscode from 'vscode';
import { COMMAND_OPEN_DIAGRAM_SVG } from '../commands';
import { Diagram } from '../diagram';
import { DiagramEditorPanel } from '../diagramEditorPanel';
import { logMessage } from '../extension';
import { MermaidPrompt } from './mermaidPrompt';

export function registerChatParticipant(context: vscode.ExtensionContext) {
    const mermaid = new MermaidChatParticipant(context);
    const handler: vscode.ChatRequestHandler = mermaid.chatRequestHandler.bind(mermaid);

    const participant = vscode.chat.createChatParticipant('copilot-diagram.mermAId', handler);
    participant.iconPath = new vscode.ThemeIcon('pie-chart');
    context.subscriptions.push(participant);
    DiagramEditorPanel.extensionUri = context.extensionUri;
}

class MermaidChatParticipant {
    constructor(
        private readonly extensionContext: vscode.ExtensionContext,
    ) { }

    async chatRequestHandler(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
        if (request.command === 'help') {
            this.handleHelpCommand(stream);
            return;
        } else if (request.command === 'iterate') {
            const diagram = DiagramEditorPanel.currentPanel?.diagram;
            if (!diagram) {
                stream.markdown('No diagram found in editor view. Please create a diagram first to iterate on it.');
                return;
            }
        }

        let retries = 0;
        let validationError = '';
        const runRequest = async () => {
            // I don't know how to configure the types so that this can be inlined
            const prompt: PromptElementAndProps<MermaidPrompt> = {
                promptElement: MermaidPrompt,
                props: { validationError, request }
            };
            const result = sendChatParticipantRequest(
                request,
                chatContext,
                {
                    prompt,
                    tools: vscode.lm.tools.filter(tool => tool.tags.includes('mermaid')),
                    responseStreamOptions: {
                        stream,
                        references: true,
                        responseText: false
                    },
                    requestJustification: 'To collaborate on diagrams',
                    extensionMode: this.extensionContext.extensionMode
                },
                token);

            let isMermaidDiagramStreamingIn = false;
            let mermaidDiagram = '';

            let responseStr = '';
            for await (const part of result.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    if (!isMermaidDiagramStreamingIn && part.value.includes('```')) {
                        // When we see a code block, assume it's a mermaid diagram
                        stream.progress('Capturing mermaid diagram from the model...');
                        isMermaidDiagramStreamingIn = true;
                    }

                    // TODO get multiple diagrams? need to handle the end?
                    if (isMermaidDiagramStreamingIn) {
                        // Gather the mermaid diagram so we can validate it
                        mermaidDiagram += part.value;
                    } else {
                        // Otherwise, render the markdown normally
                        stream.markdown(part.value);
                        responseStr += part.value;
                    }
                }
            }

            logMessage(mermaidDiagram);

            // Validate
            stream.progress('Validating mermaid diagram');
            const diagram = new Diagram(mermaidDiagram);
            const diagramResult = await DiagramEditorPanel.createOrShow(diagram);

            if (diagramResult.success) {
                const openMermaidDiagramCommand: vscode.Command = {
                    command: COMMAND_OPEN_DIAGRAM_SVG,
                    title: vscode.l10n.t('Open mermaid diagram'),
                    arguments: [diagram.content]
                };
                stream.button(openMermaidDiagramCommand);
                return await result.result;
            }

            // -- Handle parse error
            logMessage(`Not successful (on retry=${++retries})`);
            if (retries < 3) {
                if (retries === 1 && mermaidDiagram.indexOf('classDiagram') !== -1) {
                    stream.progress('Attempting to fix validation errors');
                    validationError = this.getValidationErrorMessage(diagramResult.error, mermaidDiagram, true);
                } else {
                    stream.progress('Attempting to fix validation errors');
                    validationError = this.getValidationErrorMessage(diagramResult.error, mermaidDiagram, false);
                }
                return runRequest();
            } else {
                if (diagramResult.error) {
                    logMessage(diagramResult.error);
                }
                stream.markdown('Failed to display your requested mermaid diagram. Check output log for details.\n\n');
                return await result.result;
            }
        };

        return await runRequest();
    }

    private handleHelpCommand(stream: vscode.ChatResponseStream) {
        stream.markdown(`
## Welcome to the Mermaid Diagram Generator!

Mermaid is a diagramming and charting tool that extends markdown. Visit their [website](https://mermaid.js.org/) to learn more about the tool.

This chat agent generates useful diagrams using Mermaid to help you better understand your code and communicate your ideas to others. You can chat just by typing or use a command for a more specific intent.

### Available Commands:
- **/uml**: Create Unified Modeling Language graph, or Class Diagram.
- **/sequence**: Create a sequence Diagram.
- **/iterate**: To be called when you already have a diagram up to refine, add, and change the existing diagram.

Good luck and happy diagramming!`);
    }

    private getValidationErrorMessage(error: string, diagram: string, uml: boolean) {
        let message = `Please fix this mermaid parse error to make the diagram render correctly: ${error}.\n Here is the diagram you provided:\n${diagram}`;
        if (uml) {
            message += fixUmlMessage;
        }
        return message;
    }
}

const fixUmlMessage = "\nRemember when creating the UML diagram in Mermaid, classes are represented as flat structures," +
    " and Mermaid does not support nested class definitions. Instead, each class must be defined separately, and relationships between them must be explicitly stated." +
    "Use association to connect the main class to the nested class, using cardinality to denote relationships (e.g., one-to-many)." +
    " \n example of correct syntax: \n" +
    `
                classDiagram
                    class House {
                        string address
                        int rooms
                        Kitchen kitchen
                    }
                                    
                    class Kitchen {
                        string appliances
                        int size
                    }
                                    
                    House "1" --> "1" Kitchen : kitchen
                `;