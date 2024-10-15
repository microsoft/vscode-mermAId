import * as vscode from 'vscode';
import { registerChatParticipant } from './chat/chatParticipant';
import { registerChatTool } from "./chat/additionalTools";
import { registerOutlineView } from './outlineView';
import { registerCommands } from './commands';
import { CodelensProvider } from './codeLensProvider';

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
}

export function deactivate() {
    logMessage('Deactivating mermAId');
}
