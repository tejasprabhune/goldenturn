export interface CompileOptions {
    /** Typst source string. Provide this or `path`, not both. */
    source?: string;
    /** Path to a .typ file. Relative imports in the file are preserved. */
    path?: string;
    /**
     * Prepend `#import "/._kern_preamble.typ": article` if the source does not
     * already import the preamble. Defaults to true.
     */
    autoPreamble?: boolean;
}
export interface CompileWarning {
    type: 'math-error' | 'frontmatter-warning';
    message: string;
    /** The math source that failed to render, if type is math-error. */
    source?: string;
}
export interface CompileResult {
    /** Body HTML with kern math already substituted. */
    html: string;
    /** Decoded frontmatter from the kern-frontmatter meta element. */
    frontmatter: Record<string, unknown>;
    /** Absolute paths to files Typst read during compilation. */
    deps: string[];
    /** Non-fatal warnings (e.g. individual math equations that failed). */
    warnings: CompileWarning[];
}
/**
 * Compile a Typst article to HTML with kern-rendered math.
 *
 * Returns `{ html, frontmatter, deps, warnings }`.
 * Throws if Typst is not installed or the source has a syntax error.
 */
export declare function compileArticle(options: CompileOptions): Promise<CompileResult>;
export { findTypstBinary, TypstNotFoundError } from './binary.js';
//# sourceMappingURL=index.d.ts.map