import * as vscode from 'vscode';
import { DiagramEditorPanel } from '../diagramEditorPanel';
import { logMessage } from '../extension';
import { afterIterateCommandExampleDiagram, beforeIterateCommandExampleDiagram } from './chatExamples';


export function makePrompt(command: string | undefined, validationError: string): string {
	const doc = vscode.window.activeTextEditor?.document;
	// full file contents are included through the prompt references, unless the user explicitly excludes them
	const docRef = doc ?
		`My focus is currently on the file ${doc.uri.fsPath}` :
		`There is not a current file open, the root of the workspace is: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath}`;
	const currentDiagram = DiagramEditorPanel.currentPanel?.diagram;
	const diagramRef = currentDiagram ?
		`Refer to this if it sounds like I'm referring to an existing diagram:\n${currentDiagram.content}` :
		`There isn't a diagram open that you created.`;
	const clickableSyntax = 'click {ItemLabel} call linkCallback("{ItemFilePath}#L{LineNumber}")';
	const clickableSyntaxExample = `click A call linkCallback("myClass.ts#L42")`;
	const requestCommand = getCommandPromptPart(command);
	
	return `
<instructions>
- You are a helpful chat assistant that creates diagrams using the
mermaid syntax.
- If you aren't sure which tool is relevant and feel like you are missing
context, start by searching the code base to find general information.
You can call tools repeatedly to gather as much context as needed as long
as you call the tool with different arguments each time. Don't give up
unless you are sure the request cannot be fulfilled with the tools you
have.
- If you find a relevant symbol in the code gather more information about
it with one of the symbols tools.
- Use symbol information to find the file path and line number of the
symbol so that they can be referenced in the diagram.
- The final segment of your response should always be a valid mermaid diagram
prefixed with a line containing  \`\`\`mermaid and suffixed with a line
containing \`\`\`.
- If you have the location for an item in the diagram, make it clickable by
adding adding the following syntax to the end of the line:
${clickableSyntax}
where ItemLabel is the label in the diagram and ItemFilePath and LineNumber
are the location of the item, but leave off the line number if you are unsure.
For example:
${clickableSyntaxExample}
- Make sure to only use the \`/\` character as a path separator in the links.
- Do not add anything to the response past the closing \`\`\` delimiter or
we won't be able to parse the response correctly.
- The \`\`\` delimiter should only occur in the two places mentioned above.
</instructions>
<context>
${docRef}
${diagramRef}
</context>
<instructions>
${requestCommand}
</instructions>
${validationError}
`;
}

function getCommandPromptPart(commandName: string | undefined): string {
	switch (commandName) {
		case 'iterate':
			// If diagram already exists
			const diagram = DiagramEditorPanel.currentPanel?.diagram;
			if (!diagram) {
				logMessage('Iterate: No existing diagram.');
				return 'End this chat conversation after explaining that you cannot iterate on a diagram that does not exist.';
			}
			logMessage('Iterating on existing diagram.');
			logMessage(diagram.content);
			return `
Please make changes to the currently open diagram.

There will be following instructions on how to update the diagram.
Do not make any other edits except my directed suggestion.
It is much less likely you will need to use a tool, unless the question references the codebase.
For example, if the instructions are 'Change all int data types to doubles and change Duck to Bunny' in the following diagram:
${beforeIterateCommandExampleDiagram}
Then you should emit the following diagram:
${afterIterateCommandExampleDiagram}`;
		case 'uml':
			return `
Please create UML diagram. Include all relevant classes in the file attached as context. You must use the tool mermAId_get_symbol_definition to get definitions of symbols
not defined in the current context. You should call it multiple times since you will likely need to get the definitions of multiple symbols.
Therefore for all classes you touch, explore their related classes using mermAId_get_symbol_definition to get their definitions and add them to the diagram.
All class relationships should be defined and correctly indicated using mermaid syntax. Also add the correct Cardinality / Multiplicity to associations like 1..n one to n where n is great than 1.

Remember that all class associations/should be defined! The types of relationships that you can include, and their syntax in mermaid UML diagrams, are as follows:
Inheritance: <|-- : Represents a "is-a" relationship where a subclass inherits from a superclass.
Composition: *-- : Represents a "whole-part" relationship where the part cannot exist without the whole.
Aggregation: o-- : Represents a "whole-part" relationship where the part can exist independently of the whole.
Association: --> : Represents a general connection between two classes.
Dependency: ..> : Represents a "uses" relationship where one class depends on another.
Realization: ..|> : Represents an implementation relationship between an interface and a class.
Link; solid or dashed: -- : used when no other relationship fits.`;
		case 'sequence':
			return `
Please create a mermaid sequence diagram. The diagram should include all relevant steps to describe the behaviors, actions, and steps in the user's code.
Sequence diagrams model the interactions between different parts of a system in a time-sequenced manner. There are participants which represent entities in
the system. These actors can have aliases, be group and be deactivated.
Mermaid sequence diagrams also support loops, alternative routes, parallel actions, breaks in flow, notes/comments and more.
Use all of these features to best represent the users code and add in notes and comments to provide explanation.
As always, end your message with the diagram.`;
		default:
			return `Pick an appropriate diagram type, for example: sequence, class, or flowchart.`;
	}
}
