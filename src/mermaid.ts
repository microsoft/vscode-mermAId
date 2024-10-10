import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import { logMessage } from './extension';

// promisfiy fs.writeFile
const writeFile = util.promisify(fs.writeFile);

/**
 * Exports a Mermaid diagram from a Markdown file to an SVG file.
 *
 * @param basePath - The base path where the input Markdown file and output SVG file are located.
 * @throws Will throw an error if the provided diagram does not parse, or for any other internal mermaid error.
 */
export async function exportMermaidSvg(basePath: string, mermaidDiagram: string): Promise<void> {
    logMessage(`Exporting mermaid diagram to SVG at ${basePath}`);

    // Write the diagram to a file
    logMessage('writing file...');
    await writeFile(path.join(basePath, 'diagram.md'), mermaidDiagram);
    logMessage('wrote file...');
    
    logMessage('importing mermaid-cli...');
    const mermaidCLIModule = await import('@mermaid-js/mermaid-cli'); // TODO: this seems like a hack
    logMessage('imported mermaid-cli...');

    await mermaidCLIModule.run(
        `${basePath}/diagram.md`,  // input
        `${basePath}/diagram.svg`, // output
        {
            outputFormat: 'svg',
        }
    );

    logMessage('exported mermaid diagram to SVG!');
}