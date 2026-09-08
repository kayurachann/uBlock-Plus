/* uBlock Plus+ — filter-source conditional validation. GPL-3.0-or-later. */

// Validate each original source before include expansion removes delimiters.
// Ambiguous branches must not turn into extra blocking rules or lost exceptions.
export function validateFilterConditionalStructure(text, { preparser, env } = {}) {
    const stack = [];
    const fail = (offset, reason, category = 'Invalid filter conditional structure') => {
        const line = text.slice(0, offset).split('\n').length;
        throw new TypeError(`${category} at line ${line}: ${reason}`);
    };
    const evaluateCondition = expression => {
        let unknownToken = false;
        // Reuse uBO's grammar and symbol table, including deliberately false
        // cap_* tokens. A leading unknown token must not be coerced to false
        // by a later || operand before we can reject the active condition.
        const evaluator = {
            evaluateExprToken(token, environment) {
                const value = preparser.evaluateExprToken(token, environment);
                unknownToken ||= value === undefined;
                return value;
            },
        };
        const result = preparser.evaluateExpr.call(evaluator, expression, env);
        return unknownToken ? undefined : result;
    };
    for ( const match of text.matchAll(/^!#(if|else|endif)\b([^\r\n]*)/gm) ) {
        switch ( match[1] ) {
        case 'if': {
            if ( stack.length >= 256 ) {
                fail(match.index, 'conditional nesting exceeds 256');
            }
            const parentActive = stack.at(-1)?.active ?? true;
            const condition = parentActive && preparser !== undefined
                ? evaluateCondition(match[2].trim()) : true;
            if ( condition === undefined ) {
                fail(match.index, 'unknown or invalid expression',
                    'Unsupported filter condition');
            }
            stack.push({ offset: match.index, hasElse: false,
                parentActive, active: parentActive && condition });
            break;
        }
        case 'else': {
            const current = stack.at(-1);
            if ( current === undefined ) { fail(match.index, 'orphan !#else'); }
            if ( current.hasElse ) { fail(match.index, 'duplicate !#else'); }
            current.hasElse = true;
            current.active = current.parentActive && !current.active;
            break;
        }
        case 'endif':
            if ( stack.length === 0 ) { fail(match.index, 'orphan !#endif'); }
            stack.pop();
            break;
        default:
            break;
        }
    }
    if ( stack.length !== 0 ) { fail(stack[0].offset, 'unterminated !#if'); }
}
