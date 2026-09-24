/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors
    License: GPLv3 or later.

*******************************************************************************/

// platform/mv3/re2-portable.js: the offline gate every static regexFilter of
// a Chromium package must pass. A static regex which RE2 rejects as a
// syntax error makes Chrome refuse the whole unpacked extension, so the gate
// must reject every such regex, while accepting the stock regexes Chrome
// runs. The Chrome verdicts below were measured with Chrome 153's
// declarativeNetRequest.isRegexSupported() on the stock lists.

import assert from 'node:assert/strict';
import { re2PortableReason } from '../platform/mv3/re2-portable.js';

const rejects = (regex, reason) => {
    const actual = re2PortableReason(regex);
    assert.notEqual(actual, '', `must be rejected: ${regex}`);
    if ( reason !== undefined ) {
        assert.equal(actual, reason, regex);
    }
};
const accepts = regex => {
    assert.equal(re2PortableReason(regex), '', `must be accepted: ${regex}`);
};

/******************************************************************************/

// Every regex Chrome 153 rejected as a syntax error in the stock lists,
// verbatim (`\i` and `\o` are not RE2 escapes, 1300 is above RE2's maximum
// repeat count, and RE2 has no backreferences).
for ( const [ regex, reason ] of [
    [ String.raw`^.*:\/\/w{3}\.(tu|d\ig\i)\.n\o\/(\d|[a-zA-Z_-]){130,}$`, 'unsupported-escape' ],
    [ String.raw`^https?:\/\/[-a-z]{5,13}\.[a-z]{3,6}\/[0-9a-h]{1,17}\?[0-9a-zA-Z]{1,22}=[%0-9a-zA-Z]{200,1300}`, 'repeat-too-large' ],
    [ String.raw`^https:\/\/[0-9a-z]{7}\.([0-9a-z]{7})\.top\/[0-9a-z]{7}\?t=\1&cid=[0-9a-z]+`, 'backreference-or-octal' ],
    [ String.raw`\/all\/login\.php\?([0-9a-f]{32})=\1$`, 'backreference-or-octal' ],
    [ String.raw`\/t_([0-9A-Za-z]{32})\?token=\1`, 'backreference-or-octal' ],
    [ String.raw`^.*\/all\/login\.php\?([0-9a-f]{32})=\1$`, 'backreference-or-octal' ],
    [ String.raw`^.*\/t_([0-9A-Za-z]{32})\?token=\1`, 'backreference-or-octal' ],
] ) {
    rejects(regex, reason);
}

// Stock regexes Chrome 153 accepts (a sample covering the constructs they
// use): the gate must not reject them.
for ( const regex of [
    String.raw`\/t\.js\?site=[a-f0-9]{32}\b`,
    String.raw`^https?:\/\/[\w]{5,}\.[a-z]{3,4}\/[\w\d\W]{45,}`,
    String.raw`^\w+:\/\/10\.(?:(?:[1-9]?\d|1\d\d|2(?:[0-4]\d|5[0-5]))\.){2}(?:[1-9]?\d|1\d\d|2(?:[0-4]\d|5[0-5]))[:/]`,
    String.raw`^https?:\/\/[^\s]+(\/eu_widget|\/news_widget\/|\/widget\/)`,
    String.raw`m\.3wwd\.com\/(public|static)\/\d+\.js`,
    String.raw`https?:\/\/[^\/]*18comic\.(org|vip)\/static\/.*?\d{3}[-xX_]\d{3}.*?\.gif`,
    String.raw`\/theme\/js\/[a-z0-9]{5,}\.js\?v=`,
    String.raw`jx.3aym.cn\/[0-9]{1,6}.gif`,
    String.raw`^\w+:\/\/172\.(?:1[6-9]|2\d|3[01])(?:\.(?:[1-9]?\d|1\d\d|2(?:[0-4]\d|5[0-5]))){2}[:/]`,
    String.raw`^ws:\/\/(127\.0\.0\.1|localhost):\d{4,5}\/icslite\/websocket\/`,
    String.raw`^https?:\/\/m\.anysex\.com\/[a-zA-Z]{1,4}\/[a-zA-Z]+\.php$`,
    String.raw`^https?:\/\/www\.ebay-kleinanzeigen\.de\/[a-z0-9]{8}\-[0-9a-f]{4}\-`,
    String.raw`\/[a-z]{1,3}\?zoneId\=\d{7}\-\d{7}$`,
    String.raw`\.[a-z]+[\:\/]`,
    String.raw`^\w+:\/\/\[f(?:[cd][0-9a-f]|e[89a-f])[0-9a-f]:[0-9a-f:]+\][:/]`,
    String.raw`^\w+:\/\/\[::ffff:(?:7f[0-9a-f]{2}|a[0-9a-f]{2}|ac1[0-9a-f]|c0a8|a9fe):[0-9a-f]{1,4}\][:/]`,
    String.raw`https:\/\/[www]{3}\.v{0}t{1}f{0}e{1}f{0}l{1}f{0}s{1}f{0}g{0}u{1}\.fi\/[\w]{3}\?[\d]{8}\+[\d]`,
    String.raw`^https?:\/\/kan\.znds\.com\/public\/home\/images\/[0-9]+-[0-9]+\.gif\?v=`,
    String.raw`^https:\/\/[a-z0-9]{4,10}\.tech\/c\/(?:[-a-z0-9]+\.){1,3}js$`,
    String.raw`^https:\/\/[a-z]{8,12}\.com\/en\/(?:[a-z]{2,10}\/){0,2}[a-z]{2,}\?(?:[a-z]+=[^&=?\s]*?&)*?id=[12]\d{6}\b`,
    String.raw`^https?:\/\/[-a-z]{12,}\.vercel\.app\/[^.]+?g_ep=?EgoyMDI`,
    String.raw`\/js\/[djpf]{2}(ad)?.*a\d{2}\.js`,
    String.raw`^https:\/\/dbr\.donga\.com\/upload_dir\/source\/.+\([0-9]+x[0-9]+\)\.`,
    String.raw`^https:\/\/tbc\.imgdl\.xcache\.kinxcdn\.com\/cdn[0-9]{3}\/[0-9]{8}\/[0-9%A-z_]+\([0-9]{3,4}x[0-9]{3,4}\)`,
    String.raw`:\/\/[A-Za-z0-9]+.ru\/[A-Za-z0-9]{20,25}.js`,
    String.raw`^https:\/\/i0\.wp\.com\/atlantak\.com\/wp-content\/uploads\/[0-9]+\/[0-9]+\/[0-9A-z%]+\.[a-z]+\?fit=[A-Z%,0-9]+&ssl=1$`,
    String.raw`s[-_]*s[-_]*p[-_]*\.[-_]*j[-_]*s`,
    String.raw`^https?:\/\/.*\/.*(sw[0-9a-z._-]|\.notify\.).*`,
] ) {
    accepts(regex);
}

/******************************************************************************/

// Constructs outside RE2, or read differently by RE2 versions.
rejects('a(?=b)', 'lookaround');
rejects('a(?!b)', 'lookaround');
rejects('(?<=a)b', 'lookaround');
rejects('(?<!a)b', 'lookaround');
// RE2 before 2023 (Chrome up to 152) rejects named groups
rejects('(?<n>a)', 'named-group');
rejects(String.raw`(?<n>a)\k<n>`, 'named-group');
rejects(String.raw`a\k<n>`, 'unsupported-escape');
rejects('(?P<n>a)');
for ( let digit = 0; digit <= 9; digit++ ) {
    rejects(`(a)\\${digit}`, 'backreference-or-octal');
    rejects(`[\\${digit}]`, 'backreference-or-octal');
}
rejects(String.raw`a\Z`, 'unsupported-escape');
accepts(String.raw`\Aabc\z`);
rejects(String.raw`[\A]`, 'unsupported-escape');
accepts(String.raw`\bword\B`);
rejects(String.raw`[\b]`, 'unsupported-escape');
accepts('A[A-Z]');
accepts(String.raw`\x41[\x00-\x7F]`);
rejects(String.raw`\x{41}`, 'bad-hex-escape');
rejects(String.raw`\xZZ`, 'bad-hex-escape');
rejects(String.raw`\p{L}`, 'unsupported-escape');
rejects(String.raw`\cK`, 'unsupported-escape');
rejects(String.raw`\Qa.b\E`, 'unsupported-escape');
accepts(String.raw`\_\-\/\.\:\=\ `);
rejects('(?>a)');
rejects('a++', 'invalid-js-syntax');
rejects('a{2}+', 'invalid-js-syntax');
accepts('a*?b+?c??d{2,3}?');
// RE2 rejects `[a-\d]`, JS accepts it
rejects(String.raw`[a-\d]`, 'bad-class-range');
accepts(String.raw`[\d-a]`);
accepts(String.raw`[a-]`);
// POSIX classes: RE2 reads everything up to the next `:]` as a class name
accepts('[[:alpha:][:^digit:]_]');
rejects('[[:foo:]]', 'bad-posix-class');
rejects('[[:/]x:]', 'bad-posix-class');
accepts('[[:/]');
// RE2 reads a `]` right after `[` as a literal, then needs another `]`
accepts('[]a]');
rejects('[]', 'unterminated-class');
rejects('[^]', 'unterminated-class');
accepts('(?i:abc)(?-i:def)');
rejects('(?i)abc');
rejects('é', 'non-ascii');
rejects('', 'empty');
rejects('a'.repeat(4097), 'too-long');
rejects('a(b', 'invalid-js-syntax');
rejects(`${'('.repeat(101)}a${')'.repeat(101)}`, 'nesting-too-deep');
accepts(`${'('.repeat(100)}a${')'.repeat(100)}`);

// Counted repetitions: at most 1000, also as a product of nested counts
// (RE2's RepetitionWalker; an unbounded repeat counts its minimum).
accepts('a{1000}');
accepts('a{1000,}');
accepts('a{0,1000}');
rejects('a{1001}', 'repeat-too-large');
rejects('a{1,1001}', 'repeat-too-large');
rejects('a{1001,}', 'repeat-too-large');
rejects('(a{100}){20}', 'nested-repeat-too-large');
accepts('(?:a{10}){100}');
rejects('(?:a{10}){101}', 'nested-repeat-too-large');
rejects('(a{2,}){600}', 'nested-repeat-too-large');
accepts('(a{2,}){500}');
rejects('((a{10}){10}){11}', 'nested-repeat-too-large');
accepts('((a{10}){10}){10}');
// Siblings do not multiply, zero counts do not count
accepts('a{1000}b{1000}(c{1000})');
accepts('(?:a{0}){1000}');
accepts('(?:a{10}|b{100}){10}');
rejects('(?:a{10}|b{101}){10}', 'nested-repeat-too-large');
// An escaped parenthesis is a literal, not a group
accepts(String.raw`(a{10})\){200}`);
// A `{` which is not a count is a literal
accepts('a{,5}{x');

/******************************************************************************/

// Never throws, and never accepts what JS cannot compile, whatever the
// input.
{
    let seed = 42;
    const random = n => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
    };
    const alphabet = [
        'a', 'b', '.', '*', '+', '?', '|', '(', ')', '[', ']', '{', '}', '^',
        '$', '-', ',', ':', '0', '1', '9', '\\', 'd', 'w', 'x', 'k', '<', '>',
        '=', '!', 'P', 'i', '/', '_',
    ];
    for ( let i = 0; i < 20000; i++ ) {
        let regex = '';
        const length = 1 + random(14);
        for ( let j = 0; j < length; j++ ) {
            regex += alphabet[random(alphabet.length)];
        }
        const reason = re2PortableReason(regex);
        assert.equal(typeof reason, 'string');
        if ( reason === '' ) {
            assert.doesNotThrow(( ) => new RegExp(regex), regex);
        }
    }
    assert.equal(re2PortableReason(undefined), 'empty');
}

console.log('RE2 portable subset tests passed');
