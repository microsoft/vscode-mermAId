import * as vscode from 'vscode';
import { logMessage } from './extension';
import Groq from 'groq-sdk';
import { ChatCompletionChunk, ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionToolMessageParam, ChatCompletionUserMessageParam } from 'groq-sdk/resources/chat/completions.mjs';
import { Stream } from 'groq-sdk/lib/streaming.mjs';

// Groq client
let groq: Groq;
// flag to check if Groq is enabled
export let groqEnabled = false;
/**
 * Registers the groq tool within the given VS Code extension context.
 * 
 * This function retrieves the groq API key from the extension's secrets storage.
 * If the API key is found, it initializes the groq SDK with the API key and enables groq functionality.
 * If the API key is not found, it logs a message and defaults to using only OpenAI.
 * 
 * @param context - The VS Code extension context which provides access to secrets storage and other extension resources.
 */
export function registerGroqTool(context: vscode.ExtensionContext) {
    context.secrets.get('groq-api-key').then((apiKey) => {
        if (apiKey) {
            logMessage('Retrieved groq API key, will use groq for outline view diagram generation.');
            groq = new Groq({ apiKey: apiKey });
            groqEnabled = true;
        } else {
            logMessage('No groq API key found, defaulting to using only OpenAI.');
        }
    });
}


export class GroqChatResponse {
    // seems like it needs both string and text but they represent the same thing?
    public text: Stream<ChatCompletionChunk>;
    public stream: Stream<ChatCompletionChunk>;
    constructor(text: Stream<ChatCompletionChunk>) {
        this.text = text;
        this.stream = text;
    }
}

class GroqChatUserMessage implements ChatCompletionUserMessageParam {
    public content: string;
    role: 'user';
    constructor(content: string) {
        this.content = content;
        this.role = 'user';
    }
}

class GroqChatToolMessage implements ChatCompletionToolMessageParam {
    public content: string;
    role: 'tool';
    public tool_call_id;
    constructor(content: string, tool_call_id: string) {
        this.content = content;
        this.role = 'tool';
        this.tool_call_id = tool_call_id;
    }
}

export function convertMessagesToGroq(messages: (vscode.LanguageModelChatMessage | vscode.LanguageModelToolCallPart)[]): ChatCompletionMessageParam[] {
    const groqMessages = [];
    for (const message of messages) {
        if (message instanceof vscode.LanguageModelChatMessage) {
            groqMessages.push(new GroqChatUserMessage(message.content2.join('/n')));
            if (message.content2 && message.content2 instanceof vscode.LanguageModelChatMessage) {
                // add in tool call response
                const r = message.content2;
                groqMessages.push(new GroqChatUserMessage(r.content));
            }
        } else if (message instanceof vscode.LanguageModelToolCallPart) {
            groqMessages.push(new GroqChatToolMessage(message.name, message.callId));
        }
    }
    return groqMessages;
}


export async function callWithGroq(messages: vscode.LanguageModelChatMessage[]): Promise<GroqChatResponse> {

    messages.push(vscode.LanguageModelChatMessage.User(`
Your goal is to create a comprehensive class diagram using mermaid based on the file attached as context.
The class diagram you create will be used to outline this code file in the VS Code outline view.
Start by making sure you understand the symbols in the file. You should try to call the "mermAId_get_symbol_definition" tool to get more information about symbols found in the file you do not understand.
Then create a class diagram based on the symbols you have found in the file make sure to add all associations/relationships between classes.
        
Follow these formatting rules strictly:

1. Use triple backticks (\`\`\`) to enclose any Mermaid diagrams.
2. Always specify the language as 'mermaid' right after the first set of backticks, like this: \`\`\`mermaid.
3. Only include **one** mermaid diagram per response.
4. The diagram should be a **class diagram** and nothing else.

Context Free Grammar for a MermaidDiagram:
DiagramText         → ClassDiagram
ClassDiagram        → ClassDecl | ClassDecl Relationship ClassDecl | ClassDiagram ClassDecl | ClassDiagram Relationship
ClassDecl           → "class" ClassName "{" ClassBody "}"
ClassBody           → (Attribute | Method)*
Attribute           → Visibility Name ":" Type
Method              → Visibility Name "(" ParamList ")" ":" SimpleType
ParamList           → Param ("," Param)*
Param               → Name ":" SimpleType
Relationship        → ClassName RelationType ClassName
RelationType        → "<|--" | "-->" | "<--" | "o--" | "--o" | "<|.."
Visibility          → "+" | "-" | "#"
ClassName           → Name
Name                → [a-zA-Z_][a-zA-Z0-9_]*
SimpleType          → Name

# Reject Comments:
Comment             → ε  # Comments or non-diagram text are explicitly disallowed


Example:
\`\`\`mermaid
classDiagram
    class Person {
        +name: String
        +age: int
    }

    class Student {
        +studentId: int
    }

    Person <|-- Student
\`\`\`

Thank you!`));
    const groqMessages = convertMessagesToGroq(messages);

    const tools: ChatCompletionTool[] = [
        {
            type: "function",
            function: {
                name: "mermAId_get_symbol_definition",
                description: "Given a file path string and a list of symbols, this model returns the definitions of the specified symbols. For example, if the file 'x.py' is provided and the symbol 'abc' is requested, the model will find 'abc' in 'x.py' and return its definition from the file where it is actually defined, such as 'y.py'.",
                parameters: {
                    type: "object",
                    properties: {
                        symbols: {
                            type: "array",
                            items: {
                                "type": "string"
                            },
                            description: "A list of symbols in the file to get the definition for.",
                        },
                        fileString: {
                            type: "string",
                            description: "The path to the file represented as a string where you are finding these symbols you want to get the definition for. Or undefined if the location of the symbol is unknown.",
                        }
                    },
                    required: ["symbols", "fileString"],
                },
            },
        }
    ];



    const chatCompletion: Stream<ChatCompletionChunk> = await groq.chat.completions.create({
        "messages": groqMessages,
        "model": "llama3-groq-70b-8192-tool-use-preview",
        "temperature": 1,
        "max_tokens": 1024,
        "top_p": 1,
        "stream": true,
        "stop": null,
        "tools": tools,
        "tool_choice": "auto",
    });
    return new GroqChatResponse(chatCompletion);

}
// Only include the Mermaid diagram itself, with **no additional text** outside the diagram. 