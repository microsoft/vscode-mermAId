import * as vscode from 'vscode';
import { logMessage } from "./extension";

interface MermaidParseError {
    hash: {
      text: string;
      token: string;
      line: number;
      loc: {
        first_line: number;
        last_line: number;
        first_column: number;
        last_column: number;
      };
      expected: string[];
    };
}

/*
{
  "hash": {
    "text": "{",
    "token": "OPEN_IN_STRUCT",
    "line": 9,
    "loc": {
      "first_line": 10,
      "last_line": 10,
      "first_column": 0,
      "last_column": 38
    },
    "expected": [
      "'STRUCT_STOP'",
      "'MEMBER'"
    ]
  }
}
*/
export function formatMermaidErrorToNaturalLanguage(parseResult: any): string | undefined {
    if (!parseResult || parseResult.success) {
        return;
    }

    const _error = parseResult.error;
    if (!_error) {
        return;
    }

    try {
        const mermaidError: MermaidParseError = JSON.parse(_error);
        if (!mermaidError) {
            return;
        }

        if (mermaidError.hash && mermaidError.hash.text) {
            const diagram = parseResult.diagram;
            const lineNum = mermaidError.hash.line + 1;
            let errorLineInDiagram: string | undefined;
            if (diagram) {
                // Get full line of the error
                const lines = diagram.split('\n');
                errorLineInDiagram = lines[lineNum];
            }

            let tokenMsg: string | undefined;
            if (mermaidError.hash.token && mermaidError.hash.expected.length) {
                const expected = mermaidError.hash.expected.join(', ');
                tokenMsg = `with token type '${mermaidError.hash.token}', where we expected one of: '${expected}'.`;
            }

            // Give a nice line to feed back into the LLM
            const friendlyError = `The text '${mermaidError.hash.text}' ${tokenMsg ? tokenMsg : ''} somewhere on line ${lineNum} has caused a parse error in the generated Mermaid diagram. ${errorLineInDiagram ? ` The full contents of that line is: '${errorLineInDiagram}' ` : ''} .  Please correct this and any subsequent lines with similar errors.`;
            logMessage(`friendlyError: \n${friendlyError}\n`);
            return friendlyError;
        }
    } catch (e) {
        // ignore
    }
}

export function checkForMermaidExtensions() {
  const setting = vscode.workspace.getConfiguration('mermaid').get('searchForExtensions');
  if (setting !== false) {
    const extensions = vscode.extensions.all.filter(extension => extension.packageJSON.keywords && extension.packageJSON.keywords.includes('mermaid'));
    if (extensions.length === 0) {
      const searchAction = 'Search';
      const stopShowing = 'Don\'t show again';
      vscode.window.showInformationMessage('Search for extensions to view mermaid in markdown preview?', searchAction, stopShowing).then(selectedAction => {
        if (selectedAction === searchAction) {
          vscode.commands.executeCommand('workbench.extensions.search', 'tag:mermaid');
        } else if (selectedAction === stopShowing) {
          vscode.workspace.getConfiguration('mermaid').update('searchForExtensions', false, vscode.ConfigurationTarget.Global);
        }
      });
    }
  }
}