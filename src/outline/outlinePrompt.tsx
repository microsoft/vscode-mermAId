import { BasePromptElementProps, PromptElement, PromptSizing, UserMessage } from '@vscode/prompt-tsx';
import * as vscode from 'vscode';

export interface OutlinePromptProps extends BasePromptElementProps {
    documentUri: vscode.Uri;
    validationError?: string;
}

export class OutlinePrompt extends PromptElement<OutlinePromptProps, void> {
    render(state: void, sizing: PromptSizing) {
        const doc = vscode.workspace.textDocuments.find(d => d.uri === this.props.documentUri);
        
        return (
            <>
                <UserMessage>
                    You are helpful chat assistant that creates diagrams for the user using the mermaid syntax.
                    The output diagram should represent an outline of the document.
                    Use tools to help you formulate the structure of the code.
                    You must provide a valid mermaid diagram prefixed with a line containing ```mermaid
                    and suffixed with a line containing ```.
                    Only ever include the ``` delimiter in the two places mentioned above.
                    Do not include any other text before or after the diagram, only include the diagram.
                </UserMessage>

                <UserMessage priority={500}>
                    The file the user currently has open is: {doc?.uri.fsPath} with contents: {doc?.getText()}
                </UserMessage>

                <UserMessage priority={1000}>
                    {this.props.validationError}
                </UserMessage>
            </>
        );
    }
}
