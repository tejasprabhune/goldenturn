import { resolve, relative } from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import fg from 'fast-glob';
import { compileArticle } from 'kern-typst';
export function typstLoader(options) {
    const pattern = options.pattern ?? '**/*.typ';
    return {
        name: 'kern-typst',
        async load(context) {
            const { store, logger, parseData, generateDigest, watcher, config } = context;
            const projectRoot = fileURLToPath(config.root);
            const base = resolve(projectRoot, options.base);
            const files = await fg(pattern, { cwd: base, absolute: true });
            const depMap = new Map();
            await Promise.all(files.map(async (filePath) => {
                await processFile(filePath, base, projectRoot, { store, logger, parseData, generateDigest, depMap });
            }));
            if (watcher) {
                watcher.on('change', async (changedPath) => {
                    const abs = resolve(changedPath);
                    const affected = depMap.get(abs) ?? new Set();
                    await Promise.all([...affected].map(entryId => {
                        const entry = store.get(entryId);
                        if (!entry?.filePath)
                            return;
                        return processFile(resolve(projectRoot, entry.filePath), base, projectRoot, {
                            store,
                            logger,
                            parseData,
                            generateDigest,
                            depMap,
                        });
                    }));
                });
                watcher.on('add', async (newPath) => {
                    if (!newPath.endsWith('.typ'))
                        return;
                    await processFile(resolve(newPath), base, projectRoot, {
                        store,
                        logger,
                        parseData,
                        generateDigest,
                        depMap,
                    });
                });
            }
        },
    };
}
async function processFile(filePath, base, projectRoot, ctx) {
    const { store, logger, parseData, generateDigest, depMap } = ctx;
    const id = fileToId(filePath, base);
    let source;
    try {
        source = await readFile(filePath, 'utf-8');
    }
    catch (err) {
        logger.error(`kern-typst: cannot read ${filePath}: ${String(err)}`);
        return;
    }
    const digest = generateDigest(source);
    const cached = store.get(id);
    if (cached?.digest === digest)
        return;
    try {
        const result = await compileArticle({ path: filePath });
        for (const warning of result.warnings) {
            logger.warn(`kern-typst [${id}]: ${warning.message}`);
        }
        // Update dep → entry mapping so the watcher knows what to rebuild.
        for (const dep of result.deps) {
            if (!depMap.has(dep))
                depMap.set(dep, new Set());
            depMap.get(dep).add(id);
        }
        const data = await parseData({ id, data: result.frontmatter, filePath });
        store.set({
            id,
            data,
            rendered: { html: result.html },
            digest,
            filePath: relative(projectRoot, filePath),
        });
    }
    catch (err) {
        logger.error(`kern-typst [${id}]: ${String(err)}`);
    }
}
/**
 * Converts an absolute file path to a collection entry ID.
 * `<base>/foundations/burdens-theory.typ` → `foundations/burdens-theory`
 */
function fileToId(filePath, base) {
    return relative(base, filePath).replace(/\.typ$/, '');
}
//# sourceMappingURL=loader.js.map