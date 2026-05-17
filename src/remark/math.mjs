import { visit } from 'unist-util-visit';

export default function remarkMath() {
  return (tree) => {
    visit(tree, 'text', (node, index, parent) => {
      const value = node.value;
      if (!value.includes('$')) return;

      const parts = [];
      let remaining = value;

      while (remaining.length > 0) {
        const blockIdx = remaining.indexOf('$$');

        if (blockIdx !== -1) {
          const afterOpen = remaining.indexOf('$$', blockIdx + 2);
          if (afterOpen !== -1) {
            if (blockIdx > 0) {
              parts.push({ type: 'text', value: remaining.slice(0, blockIdx) });
            }
            const math = remaining.slice(blockIdx + 2, afterOpen);
            parts.push({
              type: 'html',
              value: `<div class="math-display">${math}</div>`,
            });
            remaining = remaining.slice(afterOpen + 2);
            continue;
          }
        }

        const inlineIdx = remaining.indexOf('$');
        if (inlineIdx !== -1) {
          const closeIdx = remaining.indexOf('$', inlineIdx + 1);
          if (closeIdx !== -1) {
            if (inlineIdx > 0) {
              parts.push({ type: 'text', value: remaining.slice(0, inlineIdx) });
            }
            const math = remaining.slice(inlineIdx + 1, closeIdx);
            parts.push({
              type: 'html',
              value: `<span class="math-inline">${math}</span>`,
            });
            remaining = remaining.slice(closeIdx + 1);
            continue;
          }
        }

        parts.push({ type: 'text', value: remaining });
        break;
      }

      if (parts.length > 1 || (parts.length === 1 && parts[0].type === 'html')) {
        parent.children.splice(index, 1, ...parts);
        return index + parts.length;
      }
    });
  };
}
