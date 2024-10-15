import * as vscode from 'vscode';
import { logMessage } from '../extension';
import { Diagram } from '../diagram';
import { DiagramEditorPanel } from '../diagramEditorPanel';
import { renderPrompt } from '@vscode/prompt-tsx';
import { MermaidPrompt, ToolResultMetadata } from './mermaidPrompt';
import { ToolCallRound } from './toolMetadata';
import { COMMAND_OPEN_MARKDOWN_FILE } from '../commands';

export function registerChatParticipant(context: vscode.ExtensionContext) {
    const handler: vscode.ChatRequestHandler = chatRequestHandler;

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

    let { messages, references } = await renderPrompt(
        MermaidPrompt,
        {
            context: chatContext,
            request,
            toolCallRounds: [],
            toolCallResults: {},
            command: request.command
        },
        { modelMaxPromptTokens: model.maxInputTokens },
        model);
    references.forEach(ref => {
        if (ref.anchor instanceof vscode.Uri || ref.anchor instanceof vscode.Location) {
            stream.reference(ref.anchor);
        }
    });

    let retries = 0;
    const accumulatedToolResults: Record<string, vscode.LanguageModelToolResult> = {};
    const toolCallRounds: ToolCallRound[] = [];
    const runWithFunctions = async (): Promise<void> => {

        let isMermaidDiagramStreamingIn = false;
        let mermaidDiagram = '';

        const response = await model.sendRequest(messages, options, token);
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];

        let responseStr = '';
        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                if (!isMermaidDiagramStreamingIn && part.value.includes('```')) {
                    isMermaidDiagramStreamingIn = true;
                }

                if (isMermaidDiagramStreamingIn) {
                    mermaidDiagram += part.value;
                } else {
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
            const result = (await renderPrompt(
                MermaidPrompt,
                {
                    context: chatContext,
                    request,
                    toolCallRounds,
                    toolCallResults: accumulatedToolResults,
                    command: request.command
                },
                { modelMaxPromptTokens: model.maxInputTokens },
                model));
            messages = result.messages;
            const toolResultMetadata = result.metadatas.getAll(ToolResultMetadata);
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
            const openNewFileCommand: vscode.Command = {
                command: COMMAND_OPEN_MARKDOWN_FILE,
                title: vscode.l10n.t('Open mermaid source'),
                arguments: [diagram.content]
            };
            stream.button(openNewFileCommand);
            return;
        }

        // -- Handle parse error

        logMessage(`Not successful (on retry=${++retries})`);
        if (retries === 1) {
            addNestingContext(messages);
        }
        if (retries < 4) {
                stream.progress('Attempting to fix validation errors');
                // we might be able to reset the messages to this message only
                messages.push(vscode.LanguageModelChatMessage.User(`Please fix this mermaid parse error to make the diagram render correctly: ${result.error}. The produced diagram with the parse error is:\n${mermaidDiagram}`));
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

function specifyAssociations(messages: vscode.LanguageModelChatMessage[]) {
    messages.push(vscode.LanguageModelChatMessage.Assistant("Remember that all class associations/should be defined. In this example:"
        +
        `
            classDiagram
            class Supermarket {
                +Registers: CashRegister[]
            }
            class CashRegister {
                +process(product: Product)
            }
            `
        +
        "This Mermaid diagram is incomplete. You should have this defined like:" + `Supermarket "1" --> "*" CashRegister : has`
    ));
}

function relationshipsContext(messages: vscode.LanguageModelChatMessage[]) {
    const relationships = `
 <|-- Inheritance: Represents a "is-a" relationship where a subclass inherits from a superclass.
*-- Composition: Represents a "whole-part" relationship where the part cannot exist without the whole.
o-- Aggregation: Represents a "whole-part" relationship where the part can exist independently of the whole.
--> Association: Represents a general relationship between classes.
-- Link (Solid): Represents a connection or relationship between instances of classes.
..> Dependency: Represents a "uses" relationship where one class depends on another.
..|> Realization: Represents an implementation relationship where a class implements an interface.
.. Link (Dashed): Represents a weaker connection or relationship between instances of classes.
`;
    messages.push(vscode.LanguageModelChatMessage.Assistant(relationships));
}

