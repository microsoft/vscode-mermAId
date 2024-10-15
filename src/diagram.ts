import * as vscode from 'vscode';
import { logMessage } from "./extension";

export class Diagram {
    private validated: boolean = false;

    constructor(private readonly _content: string) {
        this._content = this._content
            .replace(/^```mermaid/, '')
            .replace(/```$/, '').trim();
    }

    get content(): string { 
        return this._content; 
    }
}