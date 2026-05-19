export { typstLoader } from './loader.js';
export type { TypstLoaderOptions } from './loader.js';
/**
 * Combines multiple Astro Content Layer loaders into one.
 * Each loader writes to the shared store independently, so they must not
 * produce overlapping entry IDs.
 *
 * @example
 * ```ts
 * import { defineCollection } from 'astro:content';
 * import { glob } from 'astro/loaders';
 * import { typstLoader, combineLoaders } from 'kern-typst-astro';
 *
 * const curriculum = defineCollection({
 *   loader: combineLoaders(
 *     glob({ pattern: '**\/*.{md,mdx}', base: './src/content/curriculum' }),
 *     typstLoader({ pattern: '**\/*.typ', base: './src/content/curriculum' }),
 *   ),
 *   schema: z.object({ title: z.string(), ... }),
 * });
 * ```
 */
import type { Loader } from 'astro/loaders';
export declare function combineLoaders(...loaders: Loader[]): Loader;
//# sourceMappingURL=index.d.ts.map