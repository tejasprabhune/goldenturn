import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import { toHtml } from 'hast-util-to-html';
import { fromHtml } from 'hast-util-from-html';
import { visit } from 'unist-util-visit';
import { renderToString } from 'kern-typ';
import { reprToKern } from './repr.js';
export async function substituteKernMath(bodyHtml) {
    const warnings = [];
    const tree = unified()
        .use(rehypeParse, { fragment: true })
        .parse(bodyHtml);
    visit(tree, 'element', (node, index, parent) => {
        if (!parent || index == null)
            return;
        if (node.tagName !== 'span')
            return;
        // hast camelCases data attributes: data-kern-math → dataKernMath
        if (!('dataKernMath' in node.properties))
            return;
        const repr = allText(node);
        const kernSrc = reprToKern(repr);
        const displayMode = node.properties['dataDisplay'] === 'block';
        try {
            const rendered = renderToString(kernSrc, { displayMode, throwOnError: true });
            const fragment = fromHtml(rendered, { fragment: true });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            parent.children.splice(index, 1, ...fragment.children);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            warnings.push({ type: 'math-error', message, source: kernSrc });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            parent.children[index] = fallback(kernSrc);
        }
    });
    return { html: toHtml(tree), warnings };
}
// Collect all text content from a node tree, stripping HTML formatting tags
// that Typst emits for repr indentation (<br>, <span style="...">).
function allText(node) {
    if (node.type === 'text')
        return node.value;
    const el = node;
    return el.children.map(c => allText(c)).join('');
}
function fallback(source) {
    return {
        type: 'element',
        tagName: 'code',
        properties: { className: ['kern-math-error'] },
        children: [{ type: 'text', value: source }],
    };
}
//# sourceMappingURL=bridge.js.map