import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import { registerChatParticipant } from './chatParticipant';
import { registerChatTool } from "./additionalTools";
import { registerOutlineView } from './outlineView';

const outputChannel = vscode.window.createOutputChannel('mermAId');
export function logMessage(message: string) {
    outputChannel.appendLine(message);
}

export function activate(context: vscode.ExtensionContext) {
    logMessage('Activating mermAId');
    logMessage(`${context.globalStorageUri.fsPath}`);

    // Create the global storage directory if it doesn't exist
    if (!fs.existsSync(context.globalStorageUri.fsPath)) {
        logMessage('Creating global storage directory...');
        fs.mkdirSync(context.globalStorageUri.fsPath);
    }

    registerOutlineView(context);
    registerChatParticipant(context);
    registerChatTool(context);
}


export function deactivate() {
    logMessage('Deactivating mermAId');
}
