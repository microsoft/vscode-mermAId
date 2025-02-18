import * as vscode from 'vscode';
import { registerChatParticipant } from './chat/chatParticipant';
import { registerChatTool } from "./chat/additionalTools";
import { registerOutlineView } from './outline/outlineView';
import { registerCommands } from './commands';
import { CodelensProvider } from './codeLensProvider';
import { registerGroqTool } from './groqHandler';

const outputChannel = vscode.window.createOutputChannel('mermAId');
export function logMessage(message: string) {
    outputChannel.appendLine(message);
}

export function activate(context: vscode.ExtensionContext) {
    logMessage('Activating mermAId');
    registerOutlineView(context);
    registerChatParticipant(context);
    registerChatTool(context);
    registerCommands();
    vscode.languages.registerCodeLensProvider("*", new CodelensProvider());


    // Register the command to store the groq API key
    let storeSecretCommand = vscode.commands.registerCommand('copilot-mermaid-diagram.storeSecret', async () => {
        const secret = await vscode.window.showInputBox({ prompt: 'Enter your groq API key' });
        if (secret) {
            // Store the secret in the global state, call to registerGroqTool to pass the api key to the groq client
            await context.secrets.store('groq-api-key', secret);
            vscode.window.showInformationMessage('groq API key stored successfully');
            registerGroqTool(context);
        }
        else {
            vscode.window.showInformationMessage('No API key entered. The groq API key was not stored.');
        }
    });

    context.subscriptions.push(storeSecretCommand);

    // register the Groq tool in case the user has already stored the API key
    registerGroqTool(context);
}

export function deactivate() {
    logMessage('Deactivating mermAId');
}
