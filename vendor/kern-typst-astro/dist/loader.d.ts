import type { Loader } from 'astro/loaders';
export interface TypstLoaderOptions {
    /** Glob pattern relative to `base`. Defaults to `**\/*.typ`. */
    pattern?: string;
    /** Base directory to scan. Resolved relative to the project root. */
    base: string;
}
export declare function typstLoader(options: TypstLoaderOptions): Loader;
//# sourceMappingURL=loader.d.ts.map