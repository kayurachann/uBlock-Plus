/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

import {
    POPUP_DEFERRED_ROUTE_CODE,
    POPUP_RUNTIME_ROUTE_CODE,
    classifyPopupCondition,
} from '../platform/mv3/extension/js/compiled-popup-matcher.js';
import {
    STOCK_POPUP_CORPUS_SCHEMA_VERSION,
    STOCK_POPUP_DEFERRED_ROUTE_CODE,
    STOCK_POPUP_SOURCE_KIND_PRECISION,
} from '../platform/mv3/popup-corpus.js';
import { experimentalManifestErrors, experimentalName } from './experimental-build-config.mjs';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { hasExactResidual } from '../platform/mv3/extension/js/stock-badfilter.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

/******************************************************************************/

const releaseMode = process.argv.includes('--release');
const experimentalMode = process.argv.includes('--experimental-webrequest');
const extensionArgument = process.argv.slice(2)
    .find(argument => argument.startsWith('--') === false);
const extensionDir = path.resolve(
    extensionArgument || (experimentalMode
        ? 'dist/build/uBlockPlus.experimental.chromium'
        : 'dist/build/uBlockPlus.chromium')
);
const errors = [];
let jsonFileCount = 0;
let jsonByteCount = 0;
let dnrRuleCount = 0;

const reportError = message => {
    errors.push(message);
};

const isValidChromiumVersion = value => {
    if ( typeof value !== 'string' ) { return false; }
    const parts = value.split('.');
    if ( parts.length < 1 || parts.length > 4 ) { return false; }
    let hasNonZeroPart = false;
    for ( const part of parts ) {
        if ( /^(?:0|[1-9]\d*)$/.test(part) === false ) { return false; }
        const number = Number(part);
        if ( Number.isSafeInteger(number) === false || number > 65535 ) {
            return false;
        }
        hasNonZeroPart ||= number !== 0;
    }
    return hasNonZeroPart;
};

const relativeExtensionPath = value => {
    if ( typeof value !== 'string' || value === '' ) { return; }
    const relative = value.replace(/^[/\\]+/, '');
    const resolved = path.resolve(extensionDir, relative);
    if (
        resolved !== extensionDir &&
        resolved.startsWith(`${extensionDir}${path.sep}`) === false
    ) {
        reportError(`Path escapes the extension directory: ${value}`);
        return;
    }
    return { relative, resolved };
};

const validateFileReference = async (value, label) => {
    const details = relativeExtensionPath(value);
    if ( details === undefined ) {
        reportError(`${label} is not a valid extension path: ${value}`);
        return;
    }
    if ( /[*?]/.test(details.relative) ) { return; }
    const stat = await fs.stat(details.resolved).catch(( ) => { });
    if ( stat?.isFile() !== true ) {
        reportError(`${label} does not exist: ${value}`);
    }
};

const validateJsonFiles = async directory => {
    for ( const entry of await fs.readdir(directory, { withFileTypes: true }) ) {
        const filePath = path.join(directory, entry.name);
        if ( entry.isDirectory() ) {
            await validateJsonFiles(filePath);
            continue;
        }
        if ( entry.isFile() === false || entry.name.endsWith('.json') === false ) {
            continue;
        }
        const content = await fs.readFile(filePath, { encoding: 'utf8' });
        jsonFileCount += 1;
        jsonByteCount += Buffer.byteLength(content);
        try {
            JSON.parse(content);
        } catch ( reason ) {
            reportError(
                `Invalid JSON in ${path.relative(extensionDir, filePath)}: ` +
                reason.message
            );
        }
    }
};

const validateDnrRuleset = async resource => {
    const details = relativeExtensionPath(resource.path);
    if ( details === undefined ) { return; }
    const rules = await fs.readFile(details.resolved, { encoding: 'utf8' })
        .then(text => JSON.parse(text))
        .catch(reason => {
            reportError(`Unable to read DNR ruleset ${resource.id}: ${reason.message}`);
        });
    if ( Array.isArray(rules) === false ) {
        reportError(`DNR ruleset ${resource.id} must contain a JSON array`);
        return;
    }
    const ids = new Set();
    for ( const rule of rules ) {
        dnrRuleCount += 1;
        if ( Number.isInteger(rule?.id) === false || rule.id < 1 ) {
            reportError(`DNR ruleset ${resource.id} contains an invalid rule ID`);
        } else if ( ids.has(rule.id) ) {
            reportError(`DNR ruleset ${resource.id} has duplicate rule ID ${rule.id}`);
        } else {
            ids.add(rule.id);
        }
        if ( typeof rule?.action?.type !== 'string' ) {
            reportError(`DNR rule ${resource.id}/${rule?.id} has no action type`);
        }
        if (
            rule?.condition instanceof Object === false ||
            Array.isArray(rule.condition)
        ) {
            reportError(`DNR rule ${resource.id}/${rule?.id} has no condition`);
        }
    }
};

const isPlainObject = value => {
    if ( typeof value !== 'object' || value === null ) { return false; }
    if ( Array.isArray(value) ) { return false; }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};

const isNonnegativeInteger = value =>
    Number.isSafeInteger(value) && value >= 0;

const validateStockPopupFilter = (filter, rulesetId, lineNumbers) => {
    if ( isPlainObject(filter) === false ) {
        reportError(`Stock popup corpus ${rulesetId} has a non-object filter`);
        return;
    }
    if ( filter.schemaVersion !== STOCK_POPUP_CORPUS_SCHEMA_VERSION ) {
        reportError(`Stock popup filter ${rulesetId} has an invalid schema`);
    }
    const exactRoute = filter.routeCode === POPUP_RUNTIME_ROUTE_CODE;
    const guardRoute = filter.routeCode === POPUP_DEFERRED_ROUTE_CODE;
    if ( exactRoute === false && guardRoute === false ) {
        reportError(`Stock popup filter ${rulesetId} has an invalid route`);
    }
    if ( filter.kind !== 'popup' ) {
        reportError(`Stock popup filter ${rulesetId} has an invalid kind`);
    }
    if ( filter.action !== 'block' && filter.action !== 'allow' ) {
        reportError(`Stock popup filter ${rulesetId} has an invalid action`);
    }
    if ( guardRoute && filter.action !== 'allow' ) {
        reportError(`Stock popup guard ${rulesetId} is not an allow`);
    }
    if ( typeof filter.important !== 'boolean' ) {
        reportError(`Stock popup filter ${rulesetId} has invalid importance`);
    }
    if ( filter.action === 'allow' && filter.important !== false ) {
        reportError(`Stock popup allow filter ${rulesetId} is marked important`);
    }
    if ( filter.listid !== rulesetId ) {
        reportError(`Stock popup filter ${rulesetId} has wrong provenance`);
    }
    if ( Number.isSafeInteger(filter.lineNumber) === false ||
        filter.lineNumber < 1 ) {
        reportError(`Stock popup filter ${rulesetId} has an invalid rule ID`);
    } else if ( lineNumbers.has(filter.lineNumber) ) {
        reportError(
            `Stock popup corpus ${rulesetId} repeats rule ID ` +
            filter.lineNumber
        );
    } else {
        lineNumbers.add(filter.lineNumber);
    }
    const classification = classifyPopupCondition(filter.condition);
    if ( exactRoute && classification.supported !== true ) {
        reportError(
            `Stock popup filter ${rulesetId}/${filter.lineNumber} cannot ` +
            `run: ${classification.reasonCode}`
        );
    } else if ( guardRoute && classification.supported === true ) {
        reportError(
            `Stock popup guard ${rulesetId}/${filter.lineNumber} is exact`
        );
    }
};

const validateStockPopupCorpora = async ruleResources => {
    if ( STOCK_POPUP_DEFERRED_ROUTE_CODE !== POPUP_DEFERRED_ROUTE_CODE ) {
        reportError('Stock popup guard route is incompatible with runtime');
    }
    const rulesetDetailsPath = path.join(
        extensionDir,
        'rulesets',
        'ruleset-details.json'
    );
    const rulesetDetails = await fs.readFile(rulesetDetailsPath, 'utf8')
        .then(text => JSON.parse(text))
        .catch(reason => {
            reportError(`Unable to read ruleset details: ${reason.message}`);
        });
    if ( Array.isArray(rulesetDetails) === false ) { return; }
    const declaredIds = new Set(ruleResources.map(resource => resource.id));
    for ( const details of rulesetDetails ) {
        const observer = details?.popupObserver;
        const rulesetId = details.id;
        if ( observer === undefined ) {
            if ( details?.popups !== undefined ) {
                reportError(
                    `Ruleset ${rulesetId} has popup rules but no observer corpus`
                );
            }
            continue;
        }
        if ( declaredIds.has(rulesetId) === false ) {
            reportError(`Stock popup corpus has undeclared ruleset ${rulesetId}`);
        }
        if ( observer.schemaVersion !== STOCK_POPUP_CORPUS_SCHEMA_VERSION ) {
            reportError(`Stock popup corpus ${rulesetId} has invalid metadata`);
        }
        if ( observer.kind !== 'popup' ||
            observer.kindPrecision !== STOCK_POPUP_SOURCE_KIND_PRECISION ||
            observer.omittedKinds?.length !== 1 ||
            observer.omittedKinds[0] !== 'popunder' ) {
            reportError(
                `Stock popup corpus ${rulesetId} overstates source-kind precision`
            );
        }
        if ( observer.lineNumberSemantics !== 'compiled-rule-id' ) {
            reportError(
                `Stock popup corpus ${rulesetId} has ambiguous provenance IDs`
            );
        }
        for ( const field of [
            'input',
            'filters',
            'runnable',
            'guards',
            'deferred',
            'discarded',
            'important',
            'block',
            'allow',
        ] ) {
            if ( isNonnegativeInteger(observer[field]) ) { continue; }
            reportError(
                `Stock popup corpus ${rulesetId} has invalid ${field} count`
            );
        }
        if ( observer.suppressed !== true &&
            observer.input !== observer.runnable + observer.deferred +
                observer.discarded ) {
            reportError(`Stock popup corpus ${rulesetId} counts do not balance`);
        }
        if ( observer.runnable !== observer.block + observer.allow ||
            observer.filters !== observer.runnable + observer.guards ||
            observer.guards > observer.deferred ||
            observer.important > observer.block ) {
            reportError(
                `Stock popup corpus ${rulesetId} action counts do not balance`
            );
        }
        const deferredReasonEntries = Object.entries(
            observer.deferredReasons || {}
        );
        if ( deferredReasonEntries.some(([ reasonCode, count ]) =>
            /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reasonCode) === false ||
            isNonnegativeInteger(count) === false
        ) ) {
            reportError(
                `Stock popup corpus ${rulesetId} has malformed deferred reasons`
            );
        }
        const reasonTotal = deferredReasonEntries.map(([, count ]) => count)
            .reduce((total, count) => total + (
                isNonnegativeInteger(count) ? count : 0
            ), 0);
        if ( reasonTotal !== observer.deferred ) {
            reportError(
                `Stock popup corpus ${rulesetId} has invalid deferred reasons`
            );
        }
        if ( observer.filters === 0 ) {
            if ( observer.path !== undefined ) {
                reportError(
                    `Empty stock popup corpus ${rulesetId} must not be packaged`
                );
            }
            continue;
        }
        if ( typeof observer.path !== 'string' ) {
            reportError(`Stock popup corpus ${rulesetId} has no package path`);
            continue;
        }
        await validateFileReference(
            observer.path,
            `Stock popup corpus ${rulesetId}`
        );
        const corpusPath = relativeExtensionPath(observer.path);
        if ( corpusPath === undefined ) { continue; }
        const corpus = await fs.readFile(corpusPath.resolved, 'utf8')
            .then(text => JSON.parse(text))
            .catch(reason => {
                reportError(
                    `Unable to read stock popup corpus ${rulesetId}: ` +
                    reason.message
                );
            });
        if ( isPlainObject(corpus) === false ) { continue; }
        if ( corpus.schemaVersion !== STOCK_POPUP_CORPUS_SCHEMA_VERSION ||
            corpus.routeCode !== POPUP_RUNTIME_ROUTE_CODE ) {
            reportError(`Stock popup corpus ${rulesetId} has invalid schema`);
        }
        if ( corpus.source?.rulesetId !== rulesetId ||
            corpus.source?.type !== 'stock-static-ruleset' ||
            corpus.source?.kind !== 'popup' ||
            corpus.source?.kindPrecision !==
                STOCK_POPUP_SOURCE_KIND_PRECISION ||
            corpus.source?.omittedKinds?.length !== 1 ||
            corpus.source?.omittedKinds[0] !== 'popunder' ||
            corpus.source?.lineNumberSemantics !== 'compiled-rule-id' ) {
            reportError(`Stock popup corpus ${rulesetId} has invalid source data`);
        }
        if ( Array.isArray(corpus.filters) === false ) {
            reportError(`Stock popup corpus ${rulesetId} has no filter array`);
            continue;
        }
        if ( corpus.filters.length !== observer.filters ||
            corpus.stats?.runnable !== observer.runnable ||
            corpus.stats?.input !== observer.input ||
            corpus.stats?.guards !== observer.guards ||
            corpus.stats?.deferred !== observer.deferred ||
            corpus.stats?.discarded !== observer.discarded ||
            corpus.stats?.important !== observer.important ||
            corpus.stats?.block !== observer.block ||
            corpus.stats?.allow !== observer.allow ||
            JSON.stringify(corpus.stats?.deferredReasons) !==
                JSON.stringify(observer.deferredReasons) ) {
            reportError(`Stock popup corpus ${rulesetId} metadata is inconsistent`);
        }
        const lineNumbers = new Set();
        for ( const filter of corpus.filters ) {
            validateStockPopupFilter(filter, rulesetId, lineNumbers);
        }
    }
};

/******************************************************************************/

const validateStockBadfilterMetadata = async ruleResources => {
    let minimizers;
    const canonicalRule = rule => JSON.stringify(rule, (key, value) => {
        if ( key === 'id' || key.startsWith('_') ) { return; }
        if ( Array.isArray(value) ) { return value.slice().sort(); }
        if ( value && typeof value === 'object' ) {
            return Object.fromEntries(Object.entries(value).sort(([ a ], [ b ]) => a.localeCompare(b)));
        }
        return value;
    });
    const index = await fs.readFile(path.join(extensionDir,
        'rulesets/badfilter-details.json'), 'utf8').then(JSON.parse).catch(( ) => undefined);
    if ( index?.schemaVersion !== 1 || isPlainObject(index.rulesets) === false ) {
        reportError('Stock badfilter source index is missing or invalid');
        return;
    }
    const hashPattern = /^[a-f0-9]{64}$/;
    for ( const resource of ruleResources ) {
        const id = resource.id;
        const entry = index.rulesets[id];
        const metadata = await fs.readFile(path.join(extensionDir,
            `rulesets/badfilter/${id}.json`), 'utf8').then(JSON.parse).catch(( ) => undefined);
        const data = await fs.readFile(path.join(extensionDir,
            resource.path.replace(/^\//, ''))).catch(( ) => undefined);
        const digest = data && createHash('sha256').update(data).digest('hex');
        if ( metadata?.schemaVersion !== 1 || entry?.digest !== digest ||
            metadata?.digest !== digest || hashPattern.test(digest ?? '') === false ||
            Array.isArray(entry?.badfilterKeys) === false ||
            entry.badfilterKeys.every(key => typeof key === 'string') === false ||
            JSON.stringify(metadata?.badfilterKeys) !== JSON.stringify(entry.badfilterKeys) ||
            Array.isArray(metadata?.rules) === false ||
            Array.isArray(metadata?.deferredKeys) === false ||
            metadata.deferredKeys.every(key => hashPattern.test(key)) === false ) {
            reportError(`Stock badfilter metadata does not match packaged ruleset ${id}`);
            continue;
        }
        const rules = JSON.parse(data.toString('utf8'));
        const ruleIds = new Set(rules.map(rule => rule.id));
        const rulesById = new Map(rules.map(rule => [ rule.id, rule ]));
        const seen = new Set();
        for ( const row of metadata.rules ) {
            if ( ruleIds.has(row.id) === false || seen.has(row.id) ||
                typeof row.complete !== 'boolean' || Array.isArray(row.keys) === false ||
                row.keys.length === 0 || row.keys.every(key => hashPattern.test(key)) === false ) {
                reportError(`Invalid stock badfilter source mapping in ${id}: ${row.id}`);
                continue;
            }
            seen.add(row.id);
            if ( row.residual === undefined ) { continue; }
            if ( hasExactResidual(row) === false ) {
                reportError(`Invalid stock residual provenance in ${id}: ${row.id}`);
                continue;
            }
            minimizers ??= await import(pathToFileURL(path.join(extensionDir, 'js/ubo-parser.js')).href);
            const originalGroups = row.residual.map(group => {
                const rule = structuredClone(group.template);
                rule.condition[group.property] = group.domains.map(entry => entry[0]);
                return rule;
            });
            const reconstructed = minimizers.minimizeRules(
                minimizers.minimizeRuleset(originalGroups));
            const original = minimizers.minimizeRules([ structuredClone(rulesById.get(row.id)) ]);
            if ( reconstructed.length !== 1 || canonicalRule(reconstructed[0]) !== canonicalRule(original[0]) ) {
                reportError(`Stock residual groups do not reconstruct native rule ${id}/${row.id}`);
            }
        }
    }
};

const validateSharedScriptletData = async () => {
    const readJSON = name => fs.readFile(path.join(extensionDir, `rulesets/${name}.json`), 'utf8')
        .then(JSON.parse).catch(() => undefined);
    const [ scripts, exceptions ] = await Promise.all([
        readJSON('scriptlet-details'), readJSON('scriptlet-exceptions'),
    ]);
    const validEntries = entries => Array.isArray(entries) && entries.every(entry =>
        Array.isArray(entry) && entry.length === 2 &&
        typeof entry[0] === 'string' &&
        /^[a-zA-Z0-9_-]+$/.test(entry[0]) && isPlainObject(entry[1])
    ) && new Set(entries.map(entry => entry[0])).size === entries.length;
    if ( validEntries(scripts) === false || validEntries(exceptions) === false ) {
        reportError('Shared scriptlet metadata is missing or invalid');
        return;
    }
    const exceptionMap = new Map(exceptions);
    const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
    for ( const [ id, details ] of exceptions ) {
        if ( Array.isArray(details.exceptions) === false || strings(details.tokens) === false ||
            details.exceptions.some(entry => strings(entry?.args) === false ||
                strings(entry?.hostnames) === false) ) {
            reportError(`Invalid scriptlet exception data in ${id}`);
        }
        for ( const token of Array.isArray(details.tokens) ? details.tokens : [] ) {
            try {
                if ( strings(JSON.parse(token)) === false ) { throw new Error(); }
            } catch { reportError(`Invalid scriptlet invocation token in ${id}`); }
        }
    }
    for ( const [ id, worlds ] of scripts ) {
        if ( exceptionMap.has(id) === false ) {
            reportError(`Scriptlet exception metadata is absent for ${id}`);
        }
        for ( const [ world, hostnames ] of Object.entries(worlds) ) {
            if ( [ 'MAIN', 'ISOLATED' ].includes(world) === false || strings(hostnames) === false ) {
                reportError(`Invalid scriptlet world metadata for ${id}`);
                continue;
            }
            const readCode = prefix => fs.readFile(path.join(extensionDir,
                `rulesets/scripting/scriptlet/${prefix}${world.toLowerCase()}/${id}.js`), 'utf8')
                .then(code => code.replace(/\r\n/g, '\n')).catch(() => '');
            const [ code, origin ] = await Promise.all([ readCode(''), readCode('origin/') ]);
            if ( code.includes('/* $scriptletExceptionData$ */ null') === false ||
                /const tokens = \[/.test(code) === false ) {
                reportError(`Packaged scriptlet ${id}/${world} lacks shared exception binding`);
            }
            const expectedOrigin = `(function uBlockPlus_originScriptlets() {\n` +
                `if ( /^(?:https?|file):$/.test(document.location.protocol) ) { return; }\n` +
                `${code}\n})();\n`;
            if ( origin !== expectedOrigin ) {
                reportError(`Packaged origin scriptlet ${id}/${world} is missing or has an unsafe guard`);
            }
        }
    }
};

const rootStat = await fs.stat(extensionDir).catch(( ) => { });
if ( rootStat?.isDirectory() !== true ) {
    throw new Error(`MV3 extension directory does not exist: ${extensionDir}`);
}

const manifestPath = path.join(extensionDir, 'manifest.json');
const manifest = await fs.readFile(manifestPath, { encoding: 'utf8' })
    .then(text => JSON.parse(text));
const experimentalMetadata = await fs.readFile(
    path.join(extensionDir, 'experimental-webrequest.json'), 'utf8'
).then(text => JSON.parse(text)).catch(reason => {
    if ( reason.code !== 'ENOENT' ) {
        reportError('Experimental build metadata cannot be read as JSON');
    }
});
for ( const error of experimentalManifestErrors(
    manifest, experimentalMetadata, experimentalMode
) ) {
    reportError(error);
}
if ( experimentalMode ) {
    for ( const requiredPath of [
        'experimental-webrequest.json',
        'start-experimental-chrome.ps1',
        'start-experimental-chrome.cmd',
        'js/webrequest-firewall.js',
    ] ) {
        await validateFileReference(requiredPath, 'Required experimental component');
    }
}

if ( manifest.manifest_version !== 3 ) {
    reportError('manifest.json must declare manifest_version 3');
}
if ( isValidChromiumVersion(manifest.version) === false ) {
    reportError(`Invalid Chromium extension version: ${manifest.version}`);
}
if ( Number.parseInt(manifest.minimum_chrome_version, 10) < 130 ) {
    reportError(
        'minimum_chrome_version must be 130+ for memory-safe storage cleanup'
    );
}
if ( manifest.name !== (experimentalMode ? experimentalName : '__MSG_extName__') ||
    manifest.short_name !== 'uBlock Plus+' ) {
    reportError('manifest.json does not use the uBlock Plus+ product identity');
}
for ( const field of [ 'permissions', 'optional_permissions' ] ) {
    const values = manifest[field] || [];
    if ( new Set(values).size !== values.length ) {
        reportError(`manifest.json ${field} contains duplicates`);
    }
}
for ( const permission of manifest.optional_permissions || [] ) {
    if ( manifest.permissions?.includes(permission) ) {
        reportError(`Permission is both required and optional: ${permission}`);
    }
}
if ( manifest.background?.service_worker === undefined ) {
    reportError('manifest.json does not declare a background service worker');
} else {
    await validateFileReference(
        manifest.background.service_worker,
        'Background service worker'
    );
}
if ( manifest.permissions?.includes('declarativeNetRequest') !== true ) {
    reportError('manifest.json does not request declarativeNetRequest');
}
if ( manifest.permissions?.includes('declarativeNetRequestFeedback') !== true ) {
    reportError(
        'Sideload builds must request declarativeNetRequestFeedback for ' +
        'matched-rule diagnostics'
    );
}
if ( manifest.permissions?.includes('userScripts') !== true ) {
    reportError('Sideload builds must request userScripts');
}
if ( manifest.permissions?.includes('webNavigation') !== true ) {
    reportError('Power builds must request webNavigation for smart popup context');
}
if ( experimentalMode === false &&
    manifest.permissions?.includes('webRequestBlocking') ) {
    reportError(
        'The unpacked Power build must not request the policy-only ' +
        'webRequestBlocking permission'
    );
}

const ruleResources = manifest.declarative_net_request?.rule_resources;
if ( Array.isArray(ruleResources) === false || ruleResources.length === 0 ) {
    reportError('manifest.json does not declare any static DNR rulesets');
} else {
    const ids = new Set();
    for ( const resource of ruleResources ) {
        if ( typeof resource.id !== 'string' || resource.id === '' ) {
            reportError('A DNR ruleset has no ID');
        } else if ( ids.has(resource.id) ) {
            reportError(`Duplicate DNR ruleset ID: ${resource.id}`);
        } else {
            ids.add(resource.id);
        }
        await validateFileReference(
            resource.path,
            `DNR ruleset ${resource.id || '<missing ID>'}`
        );
        await validateDnrRuleset(resource);
    }
    await validateStockPopupCorpora(ruleResources);
    await validateStockBadfilterMetadata(ruleResources);
    await validateSharedScriptletData();
}

await validateFileReference(manifest.action?.default_popup, 'Action popup');
await validateFileReference(manifest.options_page, 'Options page');

const popupMarkup = await fs.readFile(
    path.join(extensionDir, 'popup.html'),
    'utf8'
).catch(( ) => '');
if ( popupMarkup.includes('id="sitePower"') === false ||
    popupMarkup.includes('role="switch"') === false ) {
    reportError('Popup does not expose the per-site power switch');
}
if ( popupMarkup.includes('filteringModeSlider') ) {
    reportError('Popup contains the retired four-level slider UI');
}
if ( /<strong\b[^>]*data-i18n="extName"[^>]*>_<\/strong>/.test(
    popupMarkup
) === false ) {
    reportError('Popup product title does not use the i18n placeholder');
}
const popupStyles = await fs.readFile(
    path.join(extensionDir, 'css', 'popup.css'),
    'utf8'
).catch(( ) => '');
for ( const marker of [
    'max-height: 600px;',
    'overflow-y: auto;',
    'scrollbar-gutter: stable;',
] ) {
    if ( popupStyles.includes(marker) === false ) {
        reportError(`Popup layout stability rule is missing: ${marker}`);
    }
}
if ( popupStyles.includes('transform: scale(') ) {
    reportError('Popup controls still use a jitter-prone scale transform');
}
const dashboardMarkup = await fs.readFile(
    path.join(extensionDir, 'dashboard.html'),
    'utf8'
).catch(( ) => '');
if ( dashboardMarkup.includes('data-pane="siteRules"') === false ||
    dashboardMarkup.includes('data-pane="diagnostics"') === false ) {
    reportError('Dashboard is missing Power Console panes');
}
if ( dashboardMarkup.includes('filteringModeSlider') ) {
    reportError('Dashboard contains the retired four-level slider UI');
}
if ( dashboardMarkup.includes('cm6.bundle.ublock-plus.min.js') === false ) {
    reportError('Dashboard does not use the fork-owned CodeMirror filename');
}
for ( const [ size, iconPath ] of Object.entries(manifest.icons || {}) ) {
    await validateFileReference(iconPath, `Icon ${size}`);
}
for ( const entry of manifest.web_accessible_resources || [] ) {
    for ( const resource of entry.resources || [] ) {
        await validateFileReference(resource, 'Web-accessible resource');
    }
}
if ( typeof manifest.default_locale === 'string' ) {
    await validateFileReference(
        `_locales/${manifest.default_locale}/messages.json`,
        'Default locale'
    );
}
await validateFileReference('LICENSE.txt', 'License');
for ( const requiredPath of [
    'filter-store/catalog.json',
    'css/power-settings.css',
    'css/power-ui.css',
    'js/compiled-filters.js',
    'js/compiled-storage.js',
    'js/offscreen-storage.js',
    'js/filter-store.js',
    'js/filter-store-model.js',
    'js/imported-fetch-policy.js',
    'js/memory-manager.js',
    'js/popup-blocker.js',
    'js/popup-policy.js',
    'js/popup-panel-core.js',
    'js/popup-panel-data.js',
    'js/power-settings.js',
    'js/power-ui-core.js',
    'js/power-ui.js',
    'js/runtime-capabilities-core.js',
    'js/runtime-capabilities.js',
    'js/scriptlet-exceptions.js',
    'js/scriptlet-registration.js',
    'js/scripting/popup-context.js',
    'lib/codemirror/cm6.bundle.ublock-plus.min.js',
] ) {
    await validateFileReference(requiredPath, 'Required uBlock Plus+ component');
}
for ( const retiredPath of [
    'css/filtering-mode.css',
    'lib/codemirror/cm6.bundle.ubol.min.js',
] ) {
    const retiredStat = await fs.stat(
        path.join(extensionDir, retiredPath)
    ).catch(( ) => { });
    if ( retiredStat !== undefined ) {
        reportError(`Retired artifact is still packaged: ${retiredPath}`);
    }
}
if ( releaseMode ) {
    await validateFileReference('NOTICE.md', 'Attribution notice');
    await validateFileReference(
        'lib/s14e-serializer.LICENSE',
        's14e serializer license'
    );
    const debugRules = path.join(extensionDir, 'rulesets', 'debug');
    const debugRulesStat = await fs.stat(debugRules).catch(( ) => { });
    if ( debugRulesStat !== undefined ) {
        reportError('Release builds must not contain rulesets/debug');
    }
}
await validateJsonFiles(extensionDir);

if ( errors.length !== 0 ) {
    for ( const error of errors ) {
        console.error(`ERROR: ${error}`);
    }
    process.exitCode = 1;
} else {
    const mib = (jsonByteCount / (1024 * 1024)).toFixed(1);
    console.log(
        `Validated MV3 Chromium extension: ${ruleResources.length} rulesets, ` +
        `${dnrRuleCount} DNR rules, ${jsonFileCount} JSON files (${mib} MiB).`
    );
}
