import * as vscode from 'vscode';
import { Diagram } from './diagram';
import { logMessage } from './extension';
import { DiagramDocument } from './diagramDocument';
import { checkForMermaidExtensions } from './mermaidHelpers';

export interface WebviewResources {
	scriptUri: vscode.Uri;
	stylesResetUri: vscode.Uri;
	stylesMainUri: vscode.Uri;
	stylesCustomUri: vscode.Uri;
	codiconsUri: vscode.Uri;
	mermaidUri: vscode.Uri;
	animatedGraphUri: vscode.Uri;
}

const diagramIsActive = 'copilot-mermAId-diagram.diagramIsActive';

export type ParseDetails = { success: true; nonce: string } | { success: false; error: string; nonce: string; friendlyError?: string };


export class DiagramEditorPanel {
	/**
	 * Tracks the current panel. Only allows a single panel to exist at a time.
	 */
	public static currentPanel: DiagramEditorPanel | undefined;
	public static readonly viewType = 'mermaidDiagram';
	public static extensionUri: vscode.Uri;
	private readonly _panel: vscode.WebviewPanel;
	private parseDetails: ParseDetails[] = [];
	private _disposables: vscode.Disposable[] = [];
	private absolutePathRegex = new RegExp('^([a-zA-Z]:)?[\\/\\\\]');

	get diagram() {
		return this._diagram;
	}

	public static async createOrShow(diagram: Diagram) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		// If we already have a panel, show it.
		if (DiagramEditorPanel.currentPanel) {
			logMessage('Revealing existing panel');
			DiagramEditorPanel.currentPanel._panel.reveal(column);
			return await DiagramEditorPanel.currentPanel._validate(diagram);
		}

		// Otherwise, create a new panel.
		logMessage('Creating new panel');
		const panel = vscode.window.createWebviewPanel(
			DiagramEditorPanel.viewType,
			'@mermAId Diagram',
			column || vscode.ViewColumn.One,
			getWebviewOptions(),
		);

		vscode.commands.executeCommand('setContext', diagramIsActive, true);

		DiagramEditorPanel.currentPanel = new DiagramEditorPanel(panel, diagram);
		return DiagramEditorPanel.currentPanel._validate();
	}

	private constructor(panel: vscode.WebviewPanel, private _diagram: Diagram) {
		this._panel = panel;

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programmatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		panel.onDidChangeViewState(() => {
			if (panel.active) {
				vscode.commands.executeCommand('setContext', diagramIsActive, true);
			} else {
				vscode.commands.executeCommand('setContext', diagramIsActive, false);
			}
		});

		// Handle messages from the webview
		this._panel.webview.onDidReceiveMessage(
			async message => {
				switch (message.command) {
					case 'mermaid-source':
						await DiagramDocument.createAndShow(this._diagram);
						checkForMermaidExtensions();
						break;
					case 'parse-result':
						logMessage(`(Chat) Parse Result: ${JSON.stringify(message)}`);
						this.parseDetails.push(message);
						break;
					case 'navigate':
						const decoded = decodeURI(message.path);
						const line = parseInt(message.line.replace('L', ''), 10);

						let filepath = decoded;
						if (!this.absolutePathRegex.test(decoded)) {
							const workspaceFolders = vscode.workspace.workspaceFolders;
							if (workspaceFolders) {
								const workspace = workspaceFolders[0].uri;
								filepath = vscode.Uri.joinPath(workspace, decoded).path;
							}
						}

						const uri = vscode.Uri.from({
							scheme: 'file',
							path: filepath,
							fragment: `L${line}`,
						});

						const openEditors = vscode.window.visibleTextEditors;
						const existingEditor = openEditors.find(editor => editor.document.uri.path === uri.path);

						if (existingEditor) {
							const selection = new vscode.Range(line, 0, line, 0);
							vscode.window.showTextDocument(existingEditor.document, {
								viewColumn: existingEditor.viewColumn,
								selection
							});
						} else {
							vscode.commands.executeCommand('vscode.open', uri);
						}
						break;
				}
			},
			null,
			this._disposables
		);
	}

	public dispose() {
		DiagramEditorPanel.currentPanel = undefined;

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}

		vscode.commands.executeCommand('setContext', diagramIsActive, false);
	}

	// Validates the diagram inside of a webview.  If successful,
	// updates this webview to display the diagram.
	// On failure, returns the parse error details for the caller to handle.
	private async _validate(diagram?: Diagram): Promise<{ success: true } | { success: false, error: string }> {
		if (diagram) {
			this._diagram = diagram;
		}

		if (this.diagram.content.indexOf('```') >= 0) {
			return { success: false, error: 'diagram contains extra ``` characters' };
		}

		const webview = this._panel.webview;
		this._panel.title = '@mermAId Diagram';

		const nonce = new Date().getTime().toString();
		this._panel.webview.html = DiagramEditorPanel.getHtmlToValidateMermaid(webview, this._diagram, nonce);

		// wait for parseDetails with the expected nonce value to be set
		return new Promise<{ success: true } | { success: false, error: string }>((resolve) => {
			const interval = setInterval(() => {
				const pd = this.parseDetails.find((p) => p.nonce === nonce);
				if (pd) {
					clearInterval(interval);
					if (pd.success) {
						this._panel.webview.html = DiagramEditorPanel.getHtmlForWebview(webview, this._diagram);
						resolve({ success: true });
					} else {
						resolve({ success: false, error: pd.error });
					}
				}
			}, 100);
		});
	}


	public static getWebviewResources(webview: vscode.Webview): WebviewResources {
		// Local path to main script run in the webview
		const scriptPathOnDisk = vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'media', 'main.js');

		// And the uri we use to load this script in the webview
		const scriptUri = webview.asWebviewUri(scriptPathOnDisk);

		// Local path to css styles
		const styleResetPath = vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'media', 'reset.css');
		const stylesPathMainPath = vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'media', 'vscode.css');
		const stylesCustom = vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'media', 'styles.css');
		const animatedGraph = vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'media', 'animated_graph.svg');
		const codiconsPath = vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'dist', 'media', 'codicons', 'codicon.css');
		const mermaidPath = vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'dist', 'media', 'mermaid', 'mermaid.esm.min.mjs');

		// Uri to load styles into webview
		const stylesResetUri = webview.asWebviewUri(styleResetPath);
		const stylesMainUri = webview.asWebviewUri(stylesPathMainPath);
		const stylesCustomUri = webview.asWebviewUri(stylesCustom);
		const animatedGraphUri = webview.asWebviewUri(animatedGraph);
		const codiconsUri = webview.asWebviewUri(codiconsPath);
		const mermaidUri = webview.asWebviewUri(mermaidPath);

		return { scriptUri, stylesResetUri, stylesMainUri, stylesCustomUri, codiconsUri, mermaidUri, animatedGraphUri };
	}

	// Mermaid has a 'validate' api that can be used to check if a diagram is valid
	public static getHtmlToValidateMermaid(webview: vscode.Webview, diagram: Diagram, nonce: string) {
		const { mermaidUri, animatedGraphUri } = DiagramEditorPanel.getWebviewResources(webview);
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<style>
				body {
					display: flex;
					justify-content: center;
					align-items: center;
					height: 100vh;
					margin: 0;
				}
				</style>
			</head>
			<body>
				<img src="${animatedGraphUri}" alt="Validating image">				
				<script type="module">
				 	const vscode = acquireVsCodeApi();
					import mermaid from '${mermaidUri}';

					const diagram = \`
						${diagram.content}
					\`;

					mermaid.parseError = function (err, hash) {
						console.log('error parsing diagram');
						vscode.postMessage({
							command: 'parse-result',
							success: false,
							error: JSON.stringify(err),
							diagram,
							nonce: '${nonce}'
						});
					};
					const diagramType = await mermaid.parse(diagram);
					console.log(JSON.stringify(diagramType));
					if (diagramType) {
						vscode.postMessage({
							command: 'parse-result',
							success: true,
							diagramType: diagramType,
							nonce: '${nonce}'
						});
					}
				</script>
			</body>
		`;
	}

	public static getHtmlForWebview(webview: vscode.Webview, diagram: Diagram) {
		const { scriptUri, stylesResetUri, stylesMainUri, stylesCustomUri, codiconsUri, mermaidUri } = DiagramEditorPanel.getWebviewResources(webview);
		const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'default';
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${stylesResetUri}" rel="stylesheet">
				<link href="${stylesMainUri}" rel="stylesheet">
				<link href="${stylesCustomUri}" rel="stylesheet">
				<link href="${codiconsUri}" rel="stylesheet">

				<title>mermAId diagram</title>
			</head>
			<body>
				<div class="diagramContainer">
					<div class="toolbar">
						<span class="button">
							<button id="zoom-in">
								<div class="icon"><i class="codicon codicon-zoom-in"></i></div>
							</button>
						</span>
						<span class="button">
							<button id="zoom-out">
								<div class="icon"><i class="codicon codicon-zoom-out"></i></div>
							</button>
						</span>
					</div>
					<div id=mermaid-diagram class="diagram">
						<div id=drag-handle class="dragHandle">
							<pre id='mermaid-diagram-pre' class="mermaid">
							</pre>
						</div>
					</div>
					
			
				<script src="${scriptUri}"></script>
				<script type="module">
					import mermaid from '${mermaidUri}';

					// capture errors
					// though we shouldn't have any since we've
					// gone through the validation step already...
					mermaid.parseError = function (err, hash) {
						console.log('UNEXPECTED ERROR PARSING DIAGRAM');
						console.log(err);
					};

					const diagram = \`
					${diagram.content}
					\`;

					document.getElementById('mermaid-diagram-pre').textContent = diagram;

					// DEBUG
					console.log(document.getElementById('mermaid-diagram-pre').textContent);
					
					console.log('initializing mermaid');
					mermaid.initialize({ startOnLoad: true,  securityLevel: 'loose', theme: '${theme}' }); // loose needed to click links
					console.log('done initializing mermaid');
				</script>
			</body>
			</html>`;
	}
}

function getWebviewOptions(): vscode.WebviewOptions {
	return {
		// Enable javascript in the webview
		enableScripts: true,

		// And restrict the webview to only loading content from our extension's `media` directory and the imported codicons.
		localResourceRoots: [
			vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'media'),
			vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'dist', 'media'),
		]
	};
}
