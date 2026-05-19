// Converts the output of Typst's repr(equation.body) to kern-compatible math source.
//
// When target() == "html" and a show rule calls repr(it.body) on a math equation,
// Typst returns the AST representation of the math body. For example:
//   $x^2$   →  attach(base: [x], t: [2])
//   $frac(a,b)$  →  frac(num: [a], denom: [b])
//
// This format uses keyword arguments and content blocks ([...]), which kern
// does not parse natively. This module converts those forms to kern-compatible
// source that kern can render.
export function reprToKern(repr) {
    const p = new ReprParser(repr.trim());
    const result = p.parseExpr();
    return result.trim();
}
class ReprParser {
    src;
    pos = 0;
    constructor(src) {
        this.src = src;
    }
    skipWs() {
        while (this.pos < this.src.length && /\s/.test(this.src[this.pos]))
            this.pos++;
    }
    peek() {
        return this.src[this.pos];
    }
    consume() {
        return this.src[this.pos++];
    }
    parseExpr() {
        this.skipWs();
        if (this.pos >= this.src.length)
            return '';
        if (this.peek() === '[')
            return this.parseContentBlock();
        const ident = this.readIdent();
        if (ident) {
            this.skipWs();
            if (this.peek() === '(') {
                this.pos++; // consume '('
                return this.parseFnBody(ident);
            }
            return ident;
        }
        // Single character (operator, digit, etc.)
        if (this.peek() !== undefined) {
            return this.consume();
        }
        return '';
    }
    readIdent() {
        const start = this.pos;
        if (this.pos < this.src.length && /[a-zA-Z_]/.test(this.src[this.pos])) {
            this.pos++;
            while (this.pos < this.src.length && /[a-zA-Z0-9_.-]/.test(this.src[this.pos])) {
                this.pos++;
            }
        }
        return this.src.slice(start, this.pos);
    }
    // [text content] → text (quoted if contains spaces)
    parseContentBlock() {
        this.pos++; // consume '['
        const chars = [];
        let depth = 0;
        while (this.pos < this.src.length) {
            const ch = this.src[this.pos];
            if (ch === '[') {
                depth++;
                chars.push(ch);
                this.pos++;
            }
            else if (ch === ']') {
                if (depth === 0) {
                    this.pos++;
                    break;
                }
                depth--;
                chars.push(ch);
                this.pos++;
            }
            else {
                chars.push(ch);
                this.pos++;
            }
        }
        const text = chars.join('').trim();
        if (!text)
            return '';
        // Simple space / nbsp — drop (kern inserts spacing automatically)
        if (/^\s+$/.test(text) || text === ' ')
            return '';
        // Text with spaces → quoted string in kern
        if (/\s/.test(text))
            return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        return text;
    }
    parseFnBody(name) {
        switch (name) {
            case 'sequence': return this.parseSequenceBody();
            case 'frac': return this.parseFracBody();
            case 'attach': return this.parseAttachBody();
            case 'lr': return this.parseLrBody();
            case 'h':
            case 'v':
                this.consumeToCloseParen();
                return '';
            case 'styled': return this.parseStyledBody();
            default: return this.parseDefaultBody(name);
        }
    }
    parseSequenceBody() {
        const parts = [];
        this.skipWs();
        while (this.peek() !== ')' && this.peek() !== undefined) {
            if (this.peek() === '.' && this.src[this.pos + 1] === '.') {
                this.pos += 2; // spread — skip
                this.parseExpr();
            }
            else {
                const v = this.parseExpr();
                if (v)
                    parts.push(v);
            }
            this.skipWs();
            if (this.peek() === ',') {
                this.pos++;
                this.skipWs();
            }
        }
        if (this.peek() === ')')
            this.pos++;
        return parts.join(' ');
    }
    parseFracBody() {
        const args = this.parseNamedArgList();
        const num = args['num'] ?? args['p0'] ?? '';
        const den = args['denom'] ?? args['p1'] ?? '';
        return `frac(${num}, ${den})`;
    }
    parseAttachBody() {
        const args = this.parseNamedArgList();
        const base = args['base'] ?? args['p0'] ?? '';
        const top = args['t'];
        const bot = args['b'];
        let result = base;
        if (bot)
            result += `_(${bot})`;
        if (top)
            result += `^(${top})`;
        return result;
    }
    parseLrBody() {
        const args = this.parseNamedArgList();
        const body = args['body'] ?? args['p0'] ?? '';
        return `lr(${body})`;
    }
    parseStyledBody() {
        const args = this.parseNamedArgList();
        return args['child'] ?? args['p0'] ?? '';
    }
    parseDefaultBody(name) {
        const args = this.parseNamedArgList();
        const positional = Object.entries(args)
            .filter(([k]) => k.startsWith('p'))
            .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
            .map(([, v]) => v);
        if (positional.length === 0) {
            // All keyword args — pass values in order
            const vals = Object.values(args);
            if (vals.length === 0)
                return name;
            return `${name}(${vals.join(', ')})`;
        }
        return `${name}(${positional.join(', ')})`;
    }
    // Parse a named-argument list, returning a flat object.
    // Positional args get keys p0, p1, p2...
    parseNamedArgList() {
        const result = {};
        let pIdx = 0;
        this.skipWs();
        while (this.peek() !== ')' && this.peek() !== undefined) {
            this.skipWs();
            if (this.peek() === '.' && this.src[this.pos + 1] === '.') {
                // Spread ..expr — skip
                this.pos += 2;
                this.parseExpr();
            }
            else if (this.isNamedArg()) {
                const key = this.readIdent();
                this.skipWs();
                this.pos++; // consume ':'
                this.skipWs();
                result[key] = this.parseExpr();
            }
            else {
                result[`p${pIdx++}`] = this.parseExpr();
            }
            this.skipWs();
            if (this.peek() === ',') {
                this.pos++;
                this.skipWs();
            }
        }
        if (this.peek() === ')')
            this.pos++;
        return result;
    }
    // Look-ahead: is the current position the start of "ident :"?
    isNamedArg() {
        const saved = this.pos;
        const id = this.readIdent();
        this.skipWs();
        const yes = id.length > 0 && this.peek() === ':';
        this.pos = saved;
        return yes;
    }
    consumeToCloseParen() {
        let depth = 1;
        while (this.pos < this.src.length && depth > 0) {
            const ch = this.consume();
            if (ch === '(')
                depth++;
            else if (ch === ')')
                depth--;
        }
    }
}
//# sourceMappingURL=repr.js.map