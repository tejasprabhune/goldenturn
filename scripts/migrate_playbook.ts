import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mammoth = require('mammoth');

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function parseArgs(): { input: string; playbook: string } {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf('--input');
  const playbookIdx = args.indexOf('--playbook');
  if (inputIdx === -1 || playbookIdx === -1) {
    console.error('Usage: ts-node scripts/migrate_playbook.ts --input <path> --playbook <slug>');
    process.exit(1);
  }
  return {
    input: args[inputIdx + 1],
    playbook: args[playbookIdx + 1],
  };
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1')
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1')
    .replace(/<ul[^>]*>/gi, '')
    .replace(/<\/ul>/gi, '')
    .replace(/<ol[^>]*>/gi, '')
    .replace(/<\/ol>/gi, '')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1')
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitle(html: string): string {
  const match = html.match(/<h2[^>]*>(.*?)<\/h2>/i);
  if (!match) return '';
  return match[1].replace(/<[^>]+>/g, '').trim();
}

async function main() {
  const { input, playbook } = parseArgs();

  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const outDir = path.resolve('src/content/files');
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Reading: ${inputPath}`);
  const result = await mammoth.convertToHtml({ path: inputPath });

  if (result.messages.length > 0) {
    result.messages.forEach((m: { type: string; message: string }) => {
      if (m.type === 'warning') console.warn('  [warn]', m.message);
    });
  }

  const html: string = result.value;

  const sections = html.split(/<h2[^>]*>/i).slice(1);

  console.log(`\nFound ${sections.length} H2 sections.\n`);

  let written = 0;
  let skipped = 0;
  const skippedTitles: string[] = [];

  for (const section of sections) {
    const closingIdx = section.indexOf('</h2>');
    if (closingIdx === -1) { skipped++; continue; }

    const rawTitle = section.slice(0, closingIdx).replace(/<[^>]+>/g, '').trim();
    const body = section.slice(closingIdx + 5);
    const bodyText = htmlToMarkdown(body);

    if (bodyText.length < 30) {
      skipped++;
      skippedTitles.push(rawTitle || '(untitled)');
      console.log(`  SKIP (too short): "${rawTitle}"`);
      continue;
    }

    const titleSlug = slugify(rawTitle);
    const fileSlug = `${playbook}-${titleSlug}`;
    const filename = `${fileSlug}.md`;
    const filepath = path.join(outDir, filename);

    const frontmatter = `---
title: ${JSON.stringify(rawTitle)}
slug: "${fileSlug}"
type: "brief"
playbook: "${playbook}"
tags: []
related_articles: []
related_ks: []
---

`;

    fs.writeFileSync(filepath, frontmatter + bodyText + '\n');
    console.log(`  OK: ${filename}`);
    written++;
  }

  console.log(`\nSummary:`);
  console.log(`  Written : ${written}`);
  console.log(`  Skipped : ${skipped}`);
  if (skippedTitles.length > 0) {
    console.log(`  Skipped sections:`);
    skippedTitles.forEach(t => console.log(`    - "${t}"`));
  }
  console.log(`  Output dir: ${outDir}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
