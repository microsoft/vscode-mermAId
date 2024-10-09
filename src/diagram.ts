import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logMessage } from './extension';
import { exec } from 'child_process';

export class Diagram {
    constructor(private readonly _content: string) {
    }

    get content(): string { return this._content; }

    async validate(): Promise<{ message: string, stack: string | undefined } | undefined> {
        const tmpDir = fs.mkdtempSync(os.tmpdir());
        logMessage(tmpDir);

        // Write the diagram to a file
        fs.writeFileSync(path.join(tmpDir, 'diagram.md'), this.content);

        try {

            return new Promise((resolve, reject) => {
                exec(`npx mmdc -i ${tmpDir}/diagram.md -o ${tmpDir}/diagram.svg`, (error, stdout, stderr) => {
                    if (error) {
                        logMessage(`ERR: ${error.message}`);
                        resolve({
                            message: error.message,
                            stack: error.stack
                        });
                    } else if (stderr) {
                        logMessage(`STDERR: ${stderr}`);
                        // probably still worked?
                        resolve(undefined);
                    } else {
                        logMessage(`STDOUT: ${stdout}`);
                        resolve(undefined);
                    }
                });
            });

        } catch (e: any) {
            logMessage(`ERR: ${e?.message ?? e}`);
            return {
                message: e?.message ?? JSON.stringify(e),
                stack: e.stack
            };
        }

        return undefined;
    }
}