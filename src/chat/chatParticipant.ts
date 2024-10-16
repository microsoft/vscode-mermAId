import * as vscode from 'vscode';
import { logMessage } from '../extension';
import { Diagram } from '../diagram';
import { DiagramEditorPanel } from '../diagramEditorPanel';
import { renderPrompt } from '@vscode/prompt-tsx';
import { MermaidPrompt, ToolResultMetadata } from './mermaidPrompt';
import { ToolCallRound } from './toolMetadata';
import { COMMAND_OPEN_MARKDOWN_FILE } from '../commands';
import * as dotenv from 'dotenv';
import * as path from 'path';

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
    let groqEnabled = false;

    if (request.command === 'iterate') {
        groqEnabled = true;
    
    }

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

        // If the command is iterate, we need to check if there is a valid diagram, if not exit flow
        if (request.command === 'iterate') {
            const diagram = DiagramEditorPanel.currentPanel?.diagram;
            if (!diagram) {
                stream.markdown('No diagram found in editor view. Please create a diagram first to iterate on it.');
                return;
            }   
        }

        let isMermaidDiagramStreamingIn = false;
        let mermaidDiagram = '';

        let response;
        if (groqEnabled) {
            response = await callWithGroq(messages, stream);
        } else {
                response = await model.sendRequest(messages, options, token);
        }   

            // const response = await model.sendRequest(messages, options, token);
            const toolCalls: vscode.LanguageModelToolCallPart[] = [];

            let responseStr = '';
            let totalResponse = '';
            for await (let part of response.stream) {
                if (part !== null && 'choices' in (part as any)){
                    // This is a hack to get around Groq return style and convert it the desired shape
                    try {
                        const partContent: string = (part as any).choices[0]?.delta?.content;
                        if (partContent) {
                            // do not translate if undefined
                            part = new vscode.LanguageModelTextPart(partContent);
                        }
                        
                    } catch (e) {
                        console.log(e);
                    }
                }
                if (part instanceof vscode.LanguageModelTextPart ) {
                    if (!isMermaidDiagramStreamingIn && part.value.includes('``')) {
                        // When we see a code block, assume it's a mermaid diagram
                        stream.progress('Capturing mermaid diagram from the model...');
                        isMermaidDiagramStreamingIn = true;
                        totalResponse += part.value;
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
                
                if (!mermaidDiagram.includes('mermaid')) {
                    messages.push(vscode.LanguageModelChatMessage.User('Please add the `mermaid` keyword to the start of your diagram. Like this  \`\`\`mermaid '));
                } else {
                    addNestingContext(messages);
                }
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
        
        stream.markdown("running with function go ");
    }; // End runWithFunctions()

    await runWithFunctions();
}


function addNestingContext(messages: vscode.LanguageModelChatMessage[]) {
    messages.push(vscode.LanguageModelChatMessage.User("Remember when creating the UML diagram in Mermaid, classes are represented as flat structures," +
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
    messages.push(vscode.LanguageModelChatMessage.User("Remember that all class associations/should be defined. In this example:"
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
    messages.push(vscode.LanguageModelChatMessage.User(relationships));
}

function convertMessagesToGroq(messages: vscode.LanguageModelChatMessage[]): {role: string, content: string}[] {
    const groqMessages = [];
    for (const message of messages) {
        if (message.role === 1) {
            groqMessages.push({role:"user", content:message.content});
        }
    }
    return groqMessages;
}

class GroqChatResponse implements vscode.LanguageModelChatResponse {
    // seems like it needs both string and text but they represent the same thing?
    public text: AsyncIterable<string>;
    public stream: AsyncIterable<string>;
    constructor(text: AsyncIterable<string>) {
        this.text = text;
        this.stream = text;
    }
}


// Thenable<vscode.LanguageModelChatResponse> 
async function callWithGroq(messages: vscode.LanguageModelChatMessage[], stream: vscode.ChatResponseStream): Promise<GroqChatResponse>{
    const Groq = require('groq-sdk');
    const envPath = path.resolve(__dirname, '../.env');

    dotenv.config({path:envPath});
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        throw new Error('GROQ_API_KEY environment variable is not set');
    }
    stream.markdown("using GROQ for request... \n");

    const groq = new Groq({apiKey:apiKey});
    const groqMessages = convertMessagesToGroq(messages);

    const chatCompletion = await groq.chat.completions.create({
        "messages": groqMessages,
        "model": "llama3-8b-8192",
        "temperature": 1,
        "max_tokens": 1024,
        "top_p": 1,
        "stream": true,
        "stop": null
    });
    return new GroqChatResponse(chatCompletion);


}
