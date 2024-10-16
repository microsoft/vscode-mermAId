import {
	AssistantMessage,
	BasePromptElementProps,
	contentType as promptTsxContentType,
	PrioritizedList,
	PromptElement,
	PromptElementProps,
	PromptPiece,
	PromptSizing,
	UserMessage,
	PromptMetadata,
	ToolCall,
	Chunk,
	ToolMessage,
	PromptReference,
} from '@vscode/prompt-tsx';
import * as vscode from 'vscode';
import { isTsxMermaidMetadata, ToolCallRound } from './toolMetadata';
import { afterIterateCommandExampleDiagram, beforeIterateCommandExampleDiagram } from './chatExamples';
import { logMessage } from '../extension';
import { DiagramEditorPanel } from '../diagramEditorPanel';

export interface MermaidProps extends BasePromptElementProps {
	request: vscode.ChatRequest;
	command: string | undefined;
	context: vscode.ChatContext;
	toolCallRounds: ToolCallRound[];
	toolCallResults: Record<string, vscode.LanguageModelToolResult>;
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
			`The diagram: ${currentDiagram.content} is open, so refer to that if it sounds like I'm referring to an existing diagram.` :
			`There isn't a diagram open that you created.`;
		return (
			<>
				<UserMessage>
					Instructions: <br />
					- You are helpful chat assistant that creates diagrams using the 
					mermaid syntax. <br />
					- If you aren't sure which tool is relevant, you can call multiple
					tools. You can call tools repeatedly to take actions or gather as much
					context as needed until you have completed the task fully. Don't give up
					unless you are sure the request cannot be fulfilled with the tools you
					have. <br />
					- Don't make assumptions about the situation- gather context first, then
					perform the task or answer the question. <br />
					- Don't ask for confirmation to use tools, just use them. <br />
					- If you find a symbol you want to get the definition for, like a interface 
					implemented by a class in the context, use the provided tool <br />
					- The final segment of your response should always be a valid mermaid diagram 
					prefixed with a line containing  \`\`\`mermaid and suffixed with a line 
					containing \`\`\`. <br />
					- Do not add anything to the response past the closing \`\`\` delimiter or 
					we won't be able to parse the response correctly. <br />
					- The \`\`\` delimiter should only occur in the two places mentioned above.
					- ONLY USE ONE TOOL AT A TIME
				</UserMessage>
				<RequestCommand commandName={this.props.command ?? ''}></RequestCommand>
				<History context={this.props.context} priority={10}></History>
				<UserMessage>{docRef}</UserMessage>
				<UserMessage>{diagramRef}</UserMessage>
				<PromptReferences
					references={this.props.request.references}
					priority={20}
				/>
				<UserMessage>{this.props.request.prompt}</UserMessage>
				<ToolCalls
					toolCallRounds={this.props.toolCallRounds}
					toolInvocationToken={this.props.request.toolInvocationToken}
					toolCallResults={this.props.toolCallResults}>
				</ToolCalls>
			</>
		);
	}
}

interface ToolCallsProps extends BasePromptElementProps {
	toolCallRounds: ToolCallRound[];
	toolCallResults: Record<string, vscode.LanguageModelToolResult>;
	toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
}

const agentSupportedContentTypes = [promptTsxContentType, 'text/plain'];
const dummyCancellationToken: vscode.CancellationToken = new vscode.CancellationTokenSource().token;

class ToolCalls extends PromptElement<ToolCallsProps, void> {
	async render(state: void, sizing: PromptSizing) {
		if (!this.props.toolCallRounds.length) {
			return undefined;
		}

		// Note- the final prompt must end with a UserMessage
		return <>
			{this.props.toolCallRounds.map(round => this.renderOneToolCallRound(round, sizing))}
			<UserMessage>Above is the result of calling one or more tools, but they are not displayed, so you should explain them  if referencing them in your answer.</UserMessage>
		</>
	}

	private renderOneToolCallRound(round: ToolCallRound, sizing: PromptSizing) {
		const assistantToolCalls: ToolCall[] = round.toolCalls.map(tc => ({ type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.parameters) }, id: tc.toolCallId }));
		// TODO- just need to adopt prompt-tsx update in vscode-copilot
		return (
			<Chunk>
				<AssistantMessage toolCalls={assistantToolCalls}>{round.response || 'placeholder'}</AssistantMessage>
				{round.toolCalls.map(toolCall =>
					<ToolCallElement toolCall={toolCall} toolInvocationToken={this.props.toolInvocationToken} toolCallResult={this.props.toolCallResults[toolCall.toolCallId]}></ToolCallElement>)}
			</Chunk>);
	}
}

interface ToolCallElementProps extends BasePromptElementProps {
	toolCall: vscode.LanguageModelToolCallPart;
	toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
	toolCallResult: vscode.LanguageModelToolResult | undefined;
}

class ToolCallElement extends PromptElement<ToolCallElementProps, void> {
	async render(state: void, sizing: PromptSizing): Promise<PromptPiece | undefined> {
		const tool = vscode.lm.tools.find(t => t.name === this.props.toolCall.name);
		if (!tool) {
			console.error(`Tool not found: ${this.props.toolCall.name}`);
			return <ToolMessage toolCallId={this.props.toolCall.toolCallId}>Tool not found</ToolMessage>;
		}

		const contentType = agentSupportedContentTypes.find(type => tool.supportedContentTypes.includes(type));
		if (!contentType) {
			console.error(`Tool does not support any of the agent's content types: ${tool.name}`);
			return <ToolMessage toolCallId={this.props.toolCall.toolCallId}>Tool unsupported</ToolMessage>;
		}

		const tokenOptions: vscode.LanguageModelToolInvocationOptions<unknown>['tokenOptions'] = {
			tokenBudget: sizing.tokenBudget,
			countTokens: async (content: string) => sizing.countTokens(content),
		};

		const toolResult = this.props.toolCallResult ??
			await vscode.lm.invokeTool(this.props.toolCall.name, { parameters: this.props.toolCall.parameters, requestedContentTypes: [contentType], toolInvocationToken: this.props.toolInvocationToken, tokenOptions }, dummyCancellationToken);
		const message = (
			<ToolMessage toolCallId={this.props.toolCall.toolCallId}>
				<meta value={new ToolResultMetadata(this.props.toolCall.toolCallId, toolResult)}></meta>
				{contentType === 'text/plain' ?
					toolResult[contentType] :
					<elementJSON data={toolResult[contentType]}></elementJSON>}
			</ToolMessage>
		);
		return message;
	}
}

export class ToolResultMetadata extends PromptMetadata {
	constructor(
		public toolCallId: string,
		public result: vscode.LanguageModelToolResult,
	) {
		super();
	}
}

interface HistoryProps extends BasePromptElementProps {
	priority: number;
	context: vscode.ChatContext;
}

class History extends PromptElement<HistoryProps, void> {
	render(state: void, sizing: PromptSizing) {
		return (
			<PrioritizedList priority={this.props.priority} descending={false}>
				{this.props.context.history.map((message) => {
					if (message instanceof vscode.ChatRequestTurn) {
						return (
							<>
								{<PromptReferences references={message.references} excludeReferences={true} />}
								<UserMessage>{message.prompt}</UserMessage>
							</>
						);
					} else if (message instanceof vscode.ChatResponseTurn) {
						const metadata = message.result.metadata;
						if (isTsxMermaidMetadata(metadata) && metadata.toolCallsMetadata.toolCallRounds.length > 0) {
							return <ToolCalls toolCallResults={metadata.toolCallsMetadata.toolCallResults} toolCallRounds={metadata.toolCallsMetadata.toolCallRounds} toolInvocationToken={undefined} />;
						}

						return <AssistantMessage>{chatResponseToString(message)}</AssistantMessage>;
					}
				})}
			</PrioritizedList>
		);
	}
}

function chatResponseToString(response: vscode.ChatResponseTurn): string {
	return response.response
		.map((r) => {
			if (r instanceof vscode.ChatResponseMarkdownPart) {
				return r.value.value;
			} else if (r instanceof vscode.ChatResponseAnchorPart) {
				if (r.value instanceof vscode.Uri) {
					return r.value.fsPath;
				} else {
					return r.value.uri.fsPath;
				}
			}

			return '';
		})
		.join('');
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
						${beforeIterateCommandExampleDiagram}
						Then you should emit the following diagram:
						${afterIterateCommandExampleDiagram}
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
			default:
				return (
					<UserMessage>
						Pick an appropriate diagram type, for example: sequence, class, or flowchart.
					</UserMessage>
				);
		}
	}
}

interface PromptReferencesProps extends BasePromptElementProps {
	references: ReadonlyArray<vscode.ChatPromptReference>;
	excludeReferences?: boolean;
}

class PromptReferences extends PromptElement<PromptReferencesProps, void> {
	render(state: void, sizing: PromptSizing): PromptPiece {
		return (
			<UserMessage>
				{this.props.references.map((ref, index) => (
					<PromptReferenceElement ref={ref} excludeReferences={this.props.excludeReferences} />
				))}
			</UserMessage>
		);
	}
}

interface PromptReferenceProps extends BasePromptElementProps {
	ref: vscode.ChatPromptReference;
	excludeReferences?: boolean;
}

class PromptReferenceElement extends PromptElement<PromptReferenceProps> {
	async render(state: void, sizing: PromptSizing): Promise<PromptPiece | undefined> {
		const value = this.props.ref.value;
		// TODO make context a list of TextChunks so that it can be trimmed
		if (value instanceof vscode.Uri) {
			const fileContents = (await vscode.workspace.fs.readFile(value)).toString();
			return (
				<Tag name="context">
					{!this.props.excludeReferences && <references value={[new PromptReference(value)]} />}
					{value.fsPath}:<br />
					``` <br />
					{fileContents}<br />
					```<br />
				</Tag>
			);
		} else if (value instanceof vscode.Location) {
			const rangeText = (await vscode.workspace.openTextDocument(value.uri)).getText(value.range);
			return (
				<Tag name="context">
					{!this.props.excludeReferences && <references value={[new PromptReference(value)]} /> }
					{value.uri.fsPath}:{value.range.start.line + 1}-$<br />
					{value.range.end.line + 1}: <br />
					```<br />
					{rangeText}<br />
					```
				</Tag>
			);
		} else if (typeof value === 'string') {
			return <Tag name="context">{value}</Tag>;
		}
	}
}

export type TagProps = PromptElementProps<{
	name: string;
}>;

export class Tag extends PromptElement<TagProps> {
	private static readonly _regex = /^[a-zA-Z_][\w\.\-]*$/;

	render() {
		const { name } = this.props;

		if (!Tag._regex.test(name)) {
			throw new Error(`Invalid tag name: ${this.props.name}`);
		}

		return (
			<>
				{'<' + name + '>'}<br />
				<>
					{this.props.children}<br />
				</>
				{'</' + name + '>'}<br />
			</>
		);
	}
}
