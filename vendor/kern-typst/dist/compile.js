import { spawn } from 'child_process';
import { mkdtemp, writeFile, readFile, rm, copyFile, } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { findTypstBinary } from './binary.js';
const PREAMBLE_SRC = fileURLToPath(new URL('../preamble/kern-article.typ', import.meta.url));
const PREAMBLE_IMPORT = `#import "/_kern_preamble.typ": article\n`;
export async function compileTypst(source, filePath, autoPreamble = true) {
    const binary = await findTypstBinary();
    // If given a file path, compile next to the original so relative imports work.
    // If given raw source only, compile in a temp directory.
    const dir = filePath ? resolve(dirname(filePath)) : await mkdtemp(join(tmpdir(), 'kern-typst-'));
    const ownedDir = !filePath;
    const preambleDest = join(dir, '_kern_preamble.typ');
    const inputFile = join(dir, '_kern_article.typ');
    const outputFile = join(dir, '_kern_article.html');
    const depsFile = join(dir, '_kern_article.deps');
    try {
        await copyFile(PREAMBLE_SRC, preambleDest);
        let content = source;
        if (autoPreamble && !hasPreambleImport(source)) {
            content = PREAMBLE_IMPORT + source;
        }
        await writeFile(inputFile, content, 'utf-8');
        await runTypst(binary, [
            'compile',
            inputFile,
            outputFile,
            '--format', 'html',
            '--features', 'html',
            '--input', 'target=html',
            '--root', dir,
            '--deps', depsFile,
            '--deps-format', 'make',
        ]);
        const rawHtml = await readFile(outputFile, 'utf-8');
        const deps = await readDeps(depsFile, filePath);
        return { rawHtml, deps };
    }
    finally {
        // Clean up temp files we created in the source directory.
        await cleanup([preambleDest, inputFile, outputFile, depsFile]);
        if (ownedDir)
            await rm(dir, { recursive: true, force: true });
    }
}
function hasPreambleImport(source) {
    return (source.includes('kern-article') ||
        source.includes('_kern_preamble'));
}
function runTypst(binary, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const stderr = [];
        child.stderr.on('data', (chunk) => stderr.push(chunk));
        child.on('close', code => {
            if (code === 0) {
                resolve();
            }
            else {
                const msg = Buffer.concat(stderr).toString('utf-8').trim();
                reject(new Error(`typst exited with code ${code}:\n${msg}`));
            }
        });
        child.on('error', reject);
    });
}
async function readDeps(depsFile, originFile) {
    let content;
    try {
        content = await readFile(depsFile, 'utf-8');
    }
    catch {
        return originFile ? [resolve(originFile)] : [];
    }
    const deps = new Set();
    for (const line of content.split('\n')) {
        const colon = line.indexOf(':');
        if (colon === -1)
            continue;
        const rhs = line.slice(colon + 1).trim();
        for (const part of rhs.split(/(?<!\\)\s+/).filter(Boolean)) {
            // Typst emits paths relative to the process CWD.
            const p = resolve(process.cwd(), part.replace(/\\ /g, ' '));
            // Exclude the temp files we created.
            if (!p.includes('_kern_'))
                deps.add(p);
        }
    }
    // Always include the source file so watchers pick it up.
    if (originFile)
        deps.add(resolve(originFile));
    return [...deps];
}
async function cleanup(paths) {
    await Promise.allSettled(paths.map(p => rm(p, { force: true })));
}
//# sourceMappingURL=compile.js.map