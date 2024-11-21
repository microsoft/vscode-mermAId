import * as vscode from 'vscode';

export interface IToolCall {
    tool: vscode.LanguageModelToolInformation;
    call: vscode.LanguageModelToolCallPart;
    result: Thenable<vscode.LanguageModelToolResult>;
}
