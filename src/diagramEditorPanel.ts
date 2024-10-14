import * as vscode from 'vscode';
import { Diagram } from './diagram';
import { logMessage } from './extension';

export class DiagramEditorPanel {
	/**
	 * Tracks the current panel. Only allows a single panel to exist at a time.
	 */
	public static currentPanel: DiagramEditorPanel | undefined;

	public static readonly viewType = 'mermaidDiagram';

	public static extensionUri: vscode.Uri;

	private readonly _panel: vscode.WebviewPanel;
	private _disposables: vscode.Disposable[] = [];

	get diagram() {
		return this._diagram;
	}

	public static createOrShow(diagram: Diagram) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		// If we already have a panel, show it.
		if (DiagramEditorPanel.currentPanel) {
			logMessage('Revealing existing panel');
			DiagramEditorPanel.currentPanel._panel.reveal(column);
			DiagramEditorPanel.currentPanel._update(diagram);
			return;
		}

		// Otherwise, create a new panel.
		logMessage('Creating new panel');
		const panel = vscode.window.createWebviewPanel(
			DiagramEditorPanel.viewType,
			'@mermAId Diagram',
			column || vscode.ViewColumn.One,
			getWebviewOptions(),
		);

		DiagramEditorPanel.currentPanel = new DiagramEditorPanel(panel, diagram);
		DiagramEditorPanel.currentPanel._update();
	}

	private constructor(panel: vscode.WebviewPanel, private _diagram: Diagram) {
		this._panel = panel;

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programmatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Handle messages from the webview
		this._panel.webview.onDidReceiveMessage(
			async message => {
				switch (message.command) {
					case 'save-svg':
						const uri = await vscode.window.showSaveDialog({
							filters: {
								'SVG Files': ['svg']
							}
						});

						if (uri) {
							await vscode.workspace.fs.writeFile(uri, Buffer.from(this._diagram.asSvg(), 'utf8'));
							vscode.window.showInformationMessage('SVG saved successfully!');
						}
						break;
					case 'mermaid-source':
						const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: this._diagram.content });
						await vscode.window.showTextDocument(document);
						this.checkForMermaidExtensions();
						break;
				}
			},
			null,
			this._disposables
		);
	}

	private checkForMermaidExtensions() {
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
	}

	private _update(diagram?: Diagram) {
		if (diagram) {
			this._diagram = diagram;
		}
		const webview = this._panel.webview;
		this._panel.title = '@mermAId Diagram';
		this._panel.webview.html = DiagramEditorPanel.getHtmlForWebview(webview, this._diagram.asSvg());
	}

	public static getHtmlForWebview(webview: vscode.Webview, svg: string) {
		// Local path to main script run in the webview
		const scriptPathOnDisk = vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'media', 'main.js');

		// And the uri we use to load this script in the webview
		const scriptUri = webview.asWebviewUri(scriptPathOnDisk);

		// Local path to css styles
		const styleResetPath = vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'media', 'reset.css');
		const stylesPathMainPath = vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'media', 'vscode.css');
		const stylesCustom = vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'media', 'styles.css');
		const codiconsPath = vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css');

		// Uri to load styles into webview
		const stylesResetUri = webview.asWebviewUri(styleResetPath);
		const stylesMainUri = webview.asWebviewUri(stylesPathMainPath);
		const stylesCustomUri = webview.asWebviewUri(stylesCustom);
		const codiconsUri = webview.asWebviewUri(codiconsPath);

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
						<span class='divider'></span>
						<span class="button">
							<button id="save-svg">
								<div class="icon"><i class="codicon codicon-save-as"></i>Save SVG</div>
							</button>
						</span>
						<span class="button">
							<button id="mermaid-source">
								<div class="icon"><i class="codicon codicon-markdown"></i>View Source</div>
							</button>
						</span>
					</div>
					<div id=mermaid-diagram class="diagram">
						<div id=drag-handle class="dragHandle">
							${svg}
						</div>
					</div>
					
			
				<script src="${scriptUri}"></script>
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
			vscode.Uri.joinPath(DiagramEditorPanel.extensionUri, 'node_modules', '@vscode/codicons', 'dist')
		]
	};
}
