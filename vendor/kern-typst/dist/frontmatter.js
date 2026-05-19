import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import { toHtml } from 'hast-util-to-html';
import { visit } from 'unist-util-visit';
export function extractFrontmatter(rawHtml) {
    const processor = unified().use(rehypeParse);
    const tree = processor.parse(rawHtml);
    let frontmatter = {};
    let bodyElement = null;
    visit(tree, 'element', (node) => {
        if (node.tagName === 'meta' &&
            node.properties['name'] === 'kern-frontmatter') {
            const encoded = node.properties['content'];
            if (encoded) {
                try {
                    const json = Buffer.from(encoded, 'base64').toString('utf-8');
                    frontmatter = JSON.parse(json);
                }
                catch {
                    // Malformed frontmatter — leave as empty object.
                }
            }
        }
        if (node.tagName === 'body') {
            bodyElement = node;
        }
    });
    const bodyHtml = bodyElement
        ? toHtml({ type: 'root', children: bodyElement.children })
        : rawHtml;
    return { frontmatter, bodyHtml };
}
//# sourceMappingURL=frontmatter.js.map