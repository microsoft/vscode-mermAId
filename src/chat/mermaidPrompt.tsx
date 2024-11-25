import {
	BasePromptElementProps,
	PromptElement,
	PromptSizing,
	UserMessage
} from '@vscode/chat-extension-utils/dist/promptTsx';
import * as vscode from 'vscode';
import { DiagramEditorPanel } from '../diagramEditorPanel';
import { logMessage } from '../extension';
import { afterIterateCommandExampleDiagram, beforeIterateCommandExampleDiagram } from './chatExamples';

export interface MermaidProps extends BasePromptElementProps {
	request: vscode.ChatRequest;
	validationError: string | undefined;
}

export class MermaidPrompt extends PromptElement<MermaidProps, void> {
	render(state: void, sizing: PromptSizing) {
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
		return (
			<>
				<UserMessage>
					Instructions: <br />
					- You are helpful chat assistant that creates diagrams using the
					mermaid syntax. <br />
					- If you aren't sure which tool is relevant and feel like you are missing
					context, start by searching the code base to find general information.
					You can call tools repeatedly to gather as much context as needed as long
					as you call the tool with different arguments each time.Don't give up
					unless you are sure the request cannot be fulfilled with the tools you
					have. <br />
					- If you find a relevant symbol in the code gather more information about
					it with one of the symbols tools. <br />
					- Use symbol information to find the file path and line number of the
					symbol so that they can be referenced in the diagram. <br />
					- The final segment of your response should always be a valid mermaid diagram
					prefixed with a line containing  \`\`\`mermaid and suffixed with a line
					containing \`\`\`. <br />
					- If you have the location for an item in the diagram, make it clickable by
					adding adding the following syntax to the end of the line: <br />
					{clickableSyntax} <br />
					where ItemLabel is the label in the diagram and ItemFilePath and LineNumber
					are the location of the item, but leave off the line number if you are unsure.
					For example: <br />
					{clickableSyntaxExample} <br />
					- Make sure to only use the \`/\` character as a path separator in the links.
					<br />
					- Do not add anything to the response past the closing \`\`\` delimiter or
					we won't be able to parse the response correctly. <br />
					- The \`\`\` delimiter should only occur in the two places mentioned above.
				</UserMessage>
				<UserMessage priority={500}>{docRef}</UserMessage>
				<UserMessage priority={1500}>{diagramRef}</UserMessage>
				<RequestCommand commandName={this.props.request.command ?? ''}></RequestCommand>
				<UserMessage>{this.props.validationError}</UserMessage>
			</>
		);
	}
}

interface RequestCommandProps extends BasePromptElementProps {
	commandName: string;
}

class RequestCommand extends PromptElement<RequestCommandProps, void> {
	render(state: void, sizing: PromptSizing) {
		switch (this.props.commandName) {
			case 'iterate':
				// If diagram already exists
				const diagram = DiagramEditorPanel.currentPanel?.diagram;
				if (!diagram) {
					logMessage('Iterate: No existing diagram.');
					return (
						<>
							<UserMessage>
								End this chat conversation after explaining that you cannot iterate on a diagram that does not exist.
							</UserMessage>
						</>
					)
				}
				logMessage('Iterating on existing diagram.');
				logMessage(diagram.content);
				return (
					<>
						<UserMessage>
							Please make changes to the currently open diagram.

							There will be following instructions on how to update the diagram.
							Do not make any other edits except my directed suggestion.
							It is much less likely you will need to use a tool, unless the question references the codebase.
							For example, if the instructions are 'Change all int data types to doubles and change Duck to Bunny' in the following diagram:
							{beforeIterateCommandExampleDiagram}
							Then you should emit the following diagram:
							{afterIterateCommandExampleDiagram}
						</UserMessage>
					</>
				)
			case 'uml':
				return (
					<>
						<UserMessage>
							Please create UML diagram. Include all relevant classes in the file attached as context. You must use the tool mermAId_get_symbol_definition to get definitions of symbols
							not defined in the current context. You should call it multiple times since you will likely need to get the definitions of multiple symbols.
							Therefore for all classes you touch, explore their related classes using mermAId_get_symbol_definition to get their definitions and add them to the diagram.
							All class relationships should be defined and correctly indicated using mermaid syntax. Also add the correct Cardinality / Multiplicity to associations like 1..n one to n where n is great than 1.
						</UserMessage>
						<UserMessage>
							Remember that all class associations/should be defined! The types of relationships that you can include, and their syntax in mermaid UML diagrams, are as follows:
							Inheritance: &lt;|-- : Represents a "is-a" relationship where a subclass inherits from a superclass.
							Composition: *-- : Represents a "whole-part" relationship where the part cannot exist without the whole.
							Aggregation: o-- : Represents a "whole-part" relationship where the part can exist independently of the whole.
							Association: --&gt; : Represents a general connection between two classes.
							Dependency: ..&gt; : Represents a "uses" relationship where one class depends on another.
							Realization: ..|&gt; : Represents an implementation relationship between an interface and a class.
							Link; solid or dashed: -- : used when no other relationship fits.
						</UserMessage>
					</>
				);
			case 'sequence':
				return (
					<UserMessage>
						Please create a mermaid sequence diagram. The diagram should include all relevant steps to describe the behaviors, actions, and steps in the user's code.
						Sequence diagrams model the interactions between different parts of a system in a time-sequenced manner. There are participants which represent entities in
						the system. These actors can have aliases, be group and be deactivated.
						Mermaid sequence diagrams also support loops, alternative routes, parallel actions, breaks in flow, notes/comments and more.
						Use all of these features to best represent the users code and add in notes and comments to provide explanation.
						As always, end your message with the diagram.
					</UserMessage>
				);
			default:
				return (
					<UserMessage>
						Pick an appropriate diagram type, for example: sequence, class, or flowchart.
					</UserMessage>
				);
		}
	}
}
