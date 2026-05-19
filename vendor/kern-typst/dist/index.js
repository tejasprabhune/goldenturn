import { compileTypst } from './compile.js';
import { extractFrontmatter } from './frontmatter.js';
import { substituteKernMath } from './bridge.js';
import { readFile } from 'fs/promises';
/**
 * Compile a Typst article to HTML with kern-rendered math.
 *
 * Returns `{ html, frontmatter, deps, warnings }`.
 * Throws if Typst is not installed or the source has a syntax error.
 */
export async function compileArticle(options) {
    if (!options.source && !options.path) {
        throw new Error('compileArticle requires either `source` or `path`');
    }
    const source = options.source ?? (await readFile(options.path, 'utf-8'));
    const autoPreamble = options.autoPreamble ?? true;
    const { rawHtml, deps } = await compileTypst(source, options.path, autoPreamble);
    const { frontmatter, bodyHtml } = extractFrontmatter(rawHtml);
    const { html, warnings } = await substituteKernMath(bodyHtml);
    return { html, frontmatter, deps, warnings };
}
export { findTypstBinary, TypstNotFoundError } from './binary.js';
//# sourceMappingURL=index.js.map