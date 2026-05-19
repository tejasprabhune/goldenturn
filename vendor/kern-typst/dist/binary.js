import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
export class TypstNotFoundError extends Error {
    constructor() {
        super('Typst binary not found.\n' +
            'Install it via Homebrew:  brew install typst\n' +
            'Or download from:         https://github.com/typst/typst/releases\n' +
            'After installing, re-run your build.');
        this.name = 'TypstNotFoundError';
    }
}
let cached = null;
export async function findTypstBinary() {
    if (cached)
        return cached;
    // Try PATH first.
    const pathBinary = await probe('typst');
    if (pathBinary) {
        cached = pathBinary;
        return cached;
    }
    throw new TypstNotFoundError();
}
async function probe(bin) {
    try {
        await execFileAsync(bin, ['--version']);
        return bin;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=binary.js.map