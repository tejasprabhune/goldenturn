import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { typstLoader, combineLoaders } from 'kern-typst-astro';

const sectionEnum = z.enum(['foundations', 'aff', 'neg', 'theory', 'advanced', 'meta']);

const curriculum = defineCollection({
  loader: combineLoaders(
    glob({ pattern: '**/*.{md,mdx}', base: './src/content/curriculum' }),
    typstLoader({ pattern: '**/*.typ', base: './src/content/curriculum' }),
  ),
  schema: z.object({
    title: z.string(),
    section: sectionEnum,
    order: z.number(),
    prerequisites: z.array(z.string()).optional().default([]),
    related_articles: z.array(z.string()).optional().default([]),
    related_ks: z.array(z.string()).optional().default([]),
    related_recordings_tags: z.array(z.string()).optional().default([]),
    related_files: z.array(z.string()).optional().default([]),
    draft: z.boolean().optional().default(false),
  }),
});

const k = defineCollection({
  type: 'content',
  schema: z.object({
    name: z.string(),
    aliases: z.array(z.string()).optional().default([]),
    tags: z.array(z.string()).optional().default([]),
    related_articles: z.array(z.string()).optional().default([]),
    related_files: z.array(z.string()).optional().default([]),
  }),
});

const files = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    type: z.enum(['case', 'brief', 'scaffold', 'block']),
    author: z.string().optional(),
    year: z.number().optional(),
    tags: z.array(z.string()).optional().default([]),
    playbook: z.string().optional(),
    related_articles: z.array(z.string()).optional().default([]),
    related_ks: z.array(z.string()).optional().default([]),
    download_url: z.string().optional(),
  }),
});

const playbooks = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    author: z.string().optional(),
    year: z.number().optional(),
    description: z.string().optional(),
    download_url: z.string().optional(),
  }),
});

const lectures = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    speaker: z.string().optional(),
    video_url: z.string().optional(),
    year: z.number().optional(),
    length_minutes: z.number().optional(),
    related_articles: z.array(z.string()).optional().default([]),
  }),
});

export const collections = { curriculum, k, files, playbooks, lectures };
