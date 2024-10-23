import * as vscode from 'vscode';
import { logMessage } from '../extension';
import { Diagram } from '../diagram';
import { DiagramEditorPanel } from '../diagramEditorPanel';
import { renderPrompt, toVsCodeChatMessages } from '@vscode/prompt-tsx';
import { MermaidPrompt, ToolResultMetadata } from './mermaidPrompt';
import { ToolCallRound } from './toolMetadata';
import { COMMAND_OPEN_DIAGRAM_SVG, COMMAND_OPEN_MARKDOWN_FILE } from '../commands';
import { renderMessages } from './chatHelpers';

let developmentMode = false;

export function registerChatParticipant(context: vscode.ExtensionContext) {
    const handler: vscode.ChatRequestHandler = chatRequestHandler;

    developmentMode = context.extensionMode === vscode.ExtensionMode.Development;

    const participant = vscode.chat.createChatParticipant('copilot-diagram.mermAId', handler);
    participant.iconPath = new vscode.ThemeIcon('pie-chart');
    context.subscriptions.push(participant);
    DiagramEditorPanel.extensionUri = context.extensionUri;
}

async function chatRequestHandler(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
    const models = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        family: 'gpt-4o'
    });

    const model = models[0];

    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'To collaborate on diagrams',
    };

    options.tools = vscode.lm.tools.map((tool): vscode.LanguageModelChatTool => {
        return {
            name: tool.name,
            description: tool.description,
            parametersSchema: tool.parametersSchema ?? {}
        };
    });
    logMessage(`Available tools: ${options.tools.map(tool => tool.name).join(', ')}`);

    let { messages, references } = await renderMessages(model, {
        context: chatContext,
        request,
        toolCallRounds: [],
        toolCallResults: {},
        command: request.command,
        validationError : undefined
    }, stream, developmentMode);

    references.forEach(ref => {
        if (ref.anchor instanceof vscode.Uri || ref.anchor instanceof vscode.Location) {
            stream.reference(ref.anchor);
        }
    });

    let retries = 0;
    const accumulatedToolResults: Record<string, vscode.LanguageModelToolResult> = {};
    const toolCallRounds: ToolCallRound[] = [];
    const runWithFunctions = async (): Promise<void> => {

        if (request.command === 'help') {
            stream.markdown(`
## Welcome to the Mermaid Diagram Generator!

Mermaid is a diagramming and charting tool that extends markdown. Visit their [website](https://mermaid.js.org/) to learn more about the tool.

This chat agent generates useful diagrams using Mermaid to help you better understand your code and communicate your ideas to others. You can chat just by typing or use a command for a more specific intent.

### Available Commands:
- **\\uml**: Create Unified Modeling Language graph, or Class Diagram.
- **\\sequence**: Create a sequence Diagram.
- **\\iterate**: To be called when you already have a diagram up to refine, add, and change the existing diagram.

Good luck and happy diagramming!
            `);
            return;
        }

        if (request.command === 'iterate') {
            const diagram = DiagramEditorPanel.currentPanel?.diagram;
            if (!diagram) {
                stream.markdown('No diagram found in editor view. Please create a diagram first to iterate on it.');
                return;
            }
        }

        let isMermaidDiagramStreamingIn = false;
        let mermaidDiagram = '';

        const response = await model.sendRequest(toVsCodeChatMessages(messages), options, token);
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];

        let responseStr = '';
        let validationError: string | undefined;
        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                if (!isMermaidDiagramStreamingIn && part.value.includes('```')) {
                    // When we see a code block, assume it's a mermaid diagram
                    stream.progress('Capturing mermaid diagram from the model...');
                    isMermaidDiagramStreamingIn = true;
                }

                if (isMermaidDiagramStreamingIn) {
                    // Gather the mermaid diagram so we can validate it
                    mermaidDiagram += part.value;
                } else {
                    // Otherwise, render the markdown normally
                    stream.markdown(part.value);
                    responseStr += part.value;
                }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push(part);
            }

        }

        if (toolCalls.length) {
            toolCallRounds.push({
                response: responseStr,
                toolCalls
            });
            const result = await renderMessages(model, {
                context: chatContext,
                request,
                toolCallRounds,
                toolCallResults: accumulatedToolResults,
                command: request.command,
                validationError
            }, stream, developmentMode);
            messages = result.messages;
            const toolResultMetadata = result.metadata.getAll(ToolResultMetadata);
            if (toolResultMetadata?.length) {
                toolResultMetadata.forEach(meta => accumulatedToolResults[meta.toolCallId] = meta.result);
            }

            return runWithFunctions();
        }

        logMessage(mermaidDiagram);
        isMermaidDiagramStreamingIn = false;

        // Validate
        stream.progress('Validating mermaid diagram');
        const diagram = new Diagram(mermaidDiagram);
        const result = await DiagramEditorPanel.createOrShow(diagram);

        if (result.success) {
            const openMermaidDiagramCommand: vscode.Command = {
                command: COMMAND_OPEN_DIAGRAM_SVG,
                title: vscode.l10n.t('Open mermaid diagram'),
                arguments: [diagram.content]
            };
            stream.button(openMermaidDiagramCommand);
            return;
        }

        // -- Handle parse error
        logMessage(`Not successful (on retry=${++retries})`);
        if (retries === 1) {
            addNestingContext(toVsCodeChatMessages(messages));
        }
        if (retries < 4) {
            stream.progress('Attempting to fix validation errors');
            // we might be able to reset the messages to this message only
            validationError = `Please fix this mermaid parse error to make the diagram render correctly: ${result.error}. The produced diagram with the parse error is:\n${mermaidDiagram}`;
            return runWithFunctions();
        } {
            if (result.error) {
                logMessage(result.error);
            }
            stream.markdown('Failed to display your requested mermaid diagram. Check output log for details.\n\n');
            stream.markdown(mermaidDiagram);
        }
        
    }; // End runWithFunctions()

    await runWithFunctions();
}


function addNestingContext(messages: vscode.LanguageModelChatMessage[]) {
    messages.push(vscode.LanguageModelChatMessage.Assistant("Remember when creating the UML diagram in Mermaid, classes are represented as flat structures," +
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
                `));
}