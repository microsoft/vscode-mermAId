import { commands, window, workspace } from "vscode";
import { Diagram } from "./diagram";
import { DiagramEditorPanel } from "./diagramEditorPanel";
import { DiagramDocument } from "./diagramDocument";

export const COMMAND_OPEN_DIAGRAM_SVG = 'mermAId.openDiagramSvg';
export const COMMAND_OPEN_MARKDOWN_FILE = 'mermAId.openMarkdownFile';

export function registerCommands() {
    commands.registerCommand(COMMAND_OPEN_DIAGRAM_SVG, async (content?: string) => {
        const textContent = window.activeTextEditor?.document.getText();

        if (textContent) {
            const diagram = new Diagram(textContent);
            const result = await diagram.generateWithValidation();
            if (result.success) {
                DiagramEditorPanel.createOrShow(diagram);
            }
        }
    });

    commands.registerCommand(COMMAND_OPEN_MARKDOWN_FILE, async (content: string) => {
        const diagram = new Diagram(content);
        await DiagramDocument.createAndShow(diagram);
    });
}