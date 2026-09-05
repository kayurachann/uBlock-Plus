/*******************************************************************************

    uBlock Plus+ - an original-first MV3 fork
    Based on uBlock Origin upstream sources
    Copyright (C) 2022-present Raymond Hill
    Modifications Copyright (C) 2026-present uBlock Plus+ contributors

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

    Home: https://github.com/gorhill/uBlock
*/

import {
    ACTIVE_COMPILED_GENERATION_KEY,
    compiledStorageKey,
} from './compiled-storage.js';

import {
    addImportedLists,
    getEnabledImportedLists,
    getImportedLists,
    updateEnabledImportedLists,
} from './imported-lists.js';

import {
    i18n,
    localRead, localRemove, localWrite,
    runtime,
    sessionRead, sessionRemove, sessionWrite,
    webextFlavor,
} from './ext.js';

import {
    rulesetConfig,
    saveRulesetConfig,
} from './config.js';
import { ublockPlusErr, ublockPlusLog } from './debug.js';

import { dnr } from './ext-compat.js';
import { fetchJSON } from './fetch.js';
import { getAdminRulesets } from './admin.js';
import { hasBroadHostPermissions } from './ext-utils.js';
import { rulesFromText } from './dnr-parser.js';

/******************************************************************************/

const SPECIAL_RULES_REALM = 5000000;
const USER_RULES_BASE_RULE_ID = 9000000;
const USER_RULES_PRIORITY = 1000000;
const TRUSTED_DIRECTIVE_BASE_RULE_ID = 8000000;
const TRUSTED_DIRECTIVE_PRIORITY = USER_RULES_PRIORITY + 1000000;
const STRICTBLOCK_PRIORITY = 29;
let pendingDNRMutation = Promise.resolve();

function enqueueDNRMutation(task) {
    const result = pendingDNRMutation.then(task);
    pendingDNRMutation = result.catch(reason => {
        ublockPlusErr(`DNR transaction queue/${reason}`);
    });
    return result;
}

function appendDNRResponseError(response, reason) {
    const message = `${reason}`;
    response.error = response.error === undefined
        ? message
        : `${response.error}; ${message}`;
}

async function refreshSessionRules(response = {}) {
    try {
        const result = await updateSessionRulesNow();
        if ( result?.error ) {
            appendDNRResponseError(response, result.error);
        }
    } catch ( reason ) {
        ublockPlusErr(`updateSessionRules/${reason}`);
        appendDNRResponseError(response, reason);
    }
    return response;
}

/******************************************************************************/

const isStrictBlockRule = rule => {
    if ( rule.priority !== STRICTBLOCK_PRIORITY ) { return false; }
    if ( rule.condition?.resourceTypes === undefined ) { return false; }
    if ( rule.condition.resourceTypes.length !== 1 ) { return false; }
    if ( rule.condition.resourceTypes[0] !== 'main_frame' ) { return false; }
    if ( rule.action.type === 'redirect' ) {
        const substitution = rule.action.redirect.regexSubstitution;
        return substitution !== undefined &&
            substitution.includes('/strictblock.');
    }
    if ( rule.action.type === 'allow' ) {
        return Array.isArray(rule.condition?.requestDomains);
    }
    return false;
};

/******************************************************************************/

export function getRulesetDetails() {
    if ( getRulesetDetails.rulesetDetailsPromise === undefined ) {
        getRulesetDetails.rulesetDetailsPromise = fetchJSON('/rulesets/ruleset-details');
    }
    return Promise.all([
        getRulesetDetails.rulesetDetailsPromise,
        getImportedLists(),
    ]).then(results => {
        const [ stock, imported ] = results;
        return new Map(stock.concat(imported).map(entry => [ entry.id, entry ]));
    });
}

/******************************************************************************/

async function pruneInvalidRegexRules(realm, rulesIn, rejected = []) {
    const validateRegex = regex => {
        return dnr.isRegexSupported({ regex, isCaseSensitive: false }).then(result => {
            pruneInvalidRegexRules.validated.set(regex, result?.reason || true);
            if ( result.isSupported ) { return true; }
            rejected.push({ regex, reason: result?.reason });
            return false;
        });
    };

    // Validate regex-based rules
    const toCheck = [];
    for ( const rule of rulesIn ) {
        if ( rule.condition?.regexFilter === undefined ) {
            toCheck.push(true);
            continue;
        }
        const { regexFilter } = rule.condition;
        const reason = pruneInvalidRegexRules.validated.get(regexFilter);
        if ( reason !== undefined ) {
            toCheck.push(reason === true);
            if ( reason === true  ) { continue; }
            rejected.push({ regex: regexFilter, reason });
            continue;
        }
        toCheck.push(validateRegex(regexFilter));
    }

    // Collate results
    const isValid = await Promise.all(toCheck);

    if ( rejected.length !== 0 ) {
        ublockPlusLog(`${realm} realm: rejected regexes:\n`,
            rejected.map(e => `${e.regex} → ${e.reason}`).join('\n')
        );
    }

    return rulesIn.filter((v, i) => isValid[i]);
}
pruneInvalidRegexRules.validated = new Map();

/******************************************************************************/

const countRegexRules = rules => rules.reduce((count, rule) =>
    count + (rule?.condition?.regexFilter ? 1 : 0), 0
);

async function getDynamicRegexRuleCount() {
    const rules = await dnr.getDynamicRules();
    return countRegexRules(rules);
}

/******************************************************************************/

async function updateRegexRules(currentRules, addRules, removeRuleIds) {
    // Remove existing regex-related block rules
    for ( const rule of currentRules ) {
        if ( rule.id === 0 ) { continue; }
        if ( rule.id >= SPECIAL_RULES_REALM ) { continue; }
        if ( rule.condition.regexFilter === undefined ) { continue; }
        removeRuleIds.push(rule.id);
    }

    const rulesetDetails = await getEnabledRulesetsDetails(true);

    // Fetch regexes for all enabled rulesets
    const toFetch = [];
    for ( const details of rulesetDetails ) {
        if ( details.rules.regex === 0 ) { continue; }
        toFetch.push(fetchJSON(`/rulesets/regex/${details.id}`));
    }
    const regexRulesets = await Promise.all(toFetch);

    // Collate all regexes rules
    const allRules = [];
    for ( const rules of regexRulesets ) {
        if ( Array.isArray(rules) === false ) { continue; }
        for ( const rule of rules ) {
            allRules.push(rule);
        }
    }
    if ( allRules.length === 0 ) { return; }

    const validRules = await pruneInvalidRegexRules('regexes', allRules);
    if ( validRules.length === 0 ) { return; }

    ublockPlusLog(`Add ${validRules.length} DNR regex rules`);
    addRules.push(...validRules);
}

/******************************************************************************/

// https://github.com/uBlockOrigin/uBOL-home/issues/715

function toSafeDynamicRules(addRules) {
    const out = {
        rules: Array.isArray(addRules) ? addRules : [],
        warnings: [],
        error: '',
    };
    if ( dnr.RuleConditionKeys?.TOP_DOMAINS ) { return out; }
    const safeRules = [];
    let omittedCount = 0;
    for ( const rule of out.rules ) {
        const { condition } = rule;
        if ( condition?.topDomains !== undefined ||
            condition?.excludedTopDomains !== undefined ) {
            // Removing either scope field broadens a rule. Dropping an allow
            // exception can also broaden other rules, including rules from a
            // different list in the same batch. Keep the last good batch when
            // the browser cannot represent an exception exactly.
            if ( rule.action.type === 'allow' ||
                rule.action.type === 'allowAllRequests' ) {
                out.rules = [];
                out.error =
                    'An allow exception uses unsupported top-site ' +
                    'conditions; the previous rules remain active';
                return out;
            }
            omittedCount += 1;
            continue;
        }
        safeRules.push(rule);
    }
    out.rules = safeRules;
    if ( omittedCount !== 0 ) {
        out.warnings.push(
            `${omittedCount} rule(s) with unsupported top-site conditions ` +
            'were omitted to preserve their scope'
        );
    }
    return out;
}

/******************************************************************************/

async function updateDynamicAndSessionRulesNow() {
    const currentRules = await dnr.getDynamicRules();
    const dynamicRegexCountBefore = countRegexRules(currentRules);

    // Remove potentially left-over rules from previous version
    const removeRuleIds = [];
    for ( const rule of currentRules ) {
        if ( rule.id >= SPECIAL_RULES_REALM ) { continue; }
        removeRuleIds.push(rule.id);
        rule.id = 0;
    }

    const addRules = [];
    await updateRegexRules(currentRules, addRules, removeRuleIds);
    if ( addRules.length === 0 && removeRuleIds.length === 0 ) {
        return refreshSessionRules();
    }

    const safePlan = toSafeDynamicRules(addRules);
    if ( safePlan.error ) {
        ublockPlusErr(`updateDynamicAndSessionRules/${safePlan.error}`);
        return refreshSessionRules({ error: safePlan.error });
    }
    const safeAddRules = safePlan.rules;
    for ( const warning of safePlan.warnings ) {
        ublockPlusErr(`updateDynamicAndSessionRules/${warning}`);
    }
    // Rules in the special/user realms are not replaced by this operation.
    // Include them in the projected total so an increase in stock regex rules
    // still clears session rules before Chrome evaluates the shared regex
    // quota.
    const retainedRegexCount = currentRules.reduce((count, rule) =>
        count + (
            rule?.id >= SPECIAL_RULES_REALM &&
            rule.condition?.regexFilter
                ? 1
                : 0
        ), 0
    );
    let addedRegexCount = 0;
    let ruleId = 1;
    for ( const rule of safeAddRules ) {
        if ( rule?.condition?.regexFilter ) { addedRegexCount += 1; }
        rule.id = ruleId++;
    }
    const dynamicRegexCountAfter = retainedRegexCount + addedRegexCount;
    const maxRegexCount = Number.isSafeInteger(
        dnr.MAX_NUMBER_OF_REGEX_RULES
    ) ? dnr.MAX_NUMBER_OF_REGEX_RULES : Number.MAX_SAFE_INTEGER;
    const response = {};
    if ( safePlan.warnings.length !== 0 ) {
        response.warnings = safePlan.warnings;
    }
    if ( dynamicRegexCountAfter > maxRegexCount ) {
        response.error =
            `Dynamic regex plan requires ${dynamicRegexCountAfter}/` +
            `${maxRegexCount} rules; the previous rules remain active`;
        return refreshSessionRules(response);
    }
    if ( dynamicRegexCountAfter !== 0 ) {
        ublockPlusLog(`Using ${dynamicRegexCountAfter}/${maxRegexCount} dynamic regex-based DNR rules`);
    }

    let displacedSessionRegexRules = [];
    let sessionRegexRemoved = false;
    try {
        if ( dynamicRegexCountAfter !== dynamicRegexCountBefore ) {
            const sessionRules = await dnr.getSessionRules();
            if ( dynamicRegexCountAfter + countRegexRules(sessionRules) >
                maxRegexCount ) {
                displacedSessionRegexRules = sessionRules.filter(rule =>
                    Boolean(rule.condition?.regexFilter)
                );
                await dnr.updateSessionRules({
                    removeRuleIds: displacedSessionRegexRules.map(a => a.id),
                });
                sessionRegexRemoved = true;
            }
        }
        await dnr.updateDynamicRules({
            addRules: safeAddRules,
            removeRuleIds,
        });
        if ( removeRuleIds.length !== 0 ) {
            ublockPlusLog(`Remove ${removeRuleIds.length} dynamic DNR rules`);
        }
        if ( safeAddRules.length !== 0 ) {
            ublockPlusLog(`Add ${safeAddRules.length} dynamic DNR rules`);
        }
    } catch(reason) {
        ublockPlusErr(`updateDynamicAndSessionRules/${reason}`);
        response.error = `${reason}`;
        if ( sessionRegexRemoved ) {
            try {
                await dnr.updateSessionRules({
                    addRules: displacedSessionRegexRules,
                });
            } catch ( restoreReason ) {
                response.error +=
                    `; session rollback failed (${restoreReason})`;
            }
        }
    }

    // Strict-block session rules are independent of whether replacement of
    // stock dynamic regex rules succeeded. Rebuild them against whichever
    // dynamic snapshot Chrome actually kept.
    return refreshSessionRules(response);
}

export function updateDynamicAndSessionRules() {
    return enqueueDNRMutation(async ( ) => {
        try {
            return await updateDynamicAndSessionRulesNow();
        } catch ( reason ) {
            ublockPlusErr(`updateDynamicAndSessionRules/${reason}`);
            return refreshSessionRules({ error: `${reason}` });
        }
    });
}

/******************************************************************************/

async function updateStrictBlockRules(currentRules, addRules, removeRuleIds) {
    // Remove existing strictblock-related rules
    for ( const rule of currentRules ) {
        if ( isStrictBlockRule(rule) === false ) { continue; }
        removeRuleIds.push(rule.id);
    }

    if ( rulesetConfig.strictBlockMode === false ) { return; }

    // https://github.com/uBlockOrigin/uBOL-home/issues/428#issuecomment-3172663563
    // https://bugs.webkit.org/show_bug.cgi?id=298199
    // https://developer.apple.com/forums/thread/756214
    if ( webextFlavor === 'safari' ) { return; }

    const [
        hasOmnipotence,
        rulesetDetails,
        permanentlyExcluded = [],
        temporarilyExcluded = [],
    ] = await Promise.all([
        hasBroadHostPermissions(),
        getEnabledRulesetsDetails(true),
        localRead('excludedStrictBlockHostnames'),
        sessionRead('excludedStrictBlockHostnames'),
    ]);

    // Strict-block rules can only be enforced with omnipotence
    if ( hasOmnipotence === false ) {
        localRemove('excludedStrictBlockHostnames');
        sessionRemove('excludedStrictBlockHostnames');
        return;
    }

    // Fetch strick-block rules
    const toFetch = [];
    for ( const details of rulesetDetails ) {
        if ( Boolean(details.rules.strictblock) === false ) { continue; }
        toFetch.push(fetchJSON(`/rulesets/strictblock/${details.id}`));
    }
    const rulesets = await Promise.all(toFetch);

    const substitution = `${runtime.getURL('/strictblock.html')}#\\0`;
    const allRules = [];
    for ( const rules of rulesets ) {
        if ( Array.isArray(rules) === false ) { continue; }
        for ( const rule of rules ) {
            rule.action.redirect.regexSubstitution = substitution;
            allRules.push(rule);
        }
    }

    const validRules = await pruneInvalidRegexRules('strictblock', allRules);
    if ( validRules.length === 0 ) { return; }
    ublockPlusLog(`Add ${validRules.length} DNR strictblock rules`);
    for ( const rule of validRules ) {
        rule.priority = STRICTBLOCK_PRIORITY;
        addRules.push(rule);
    }

    const allExcluded = permanentlyExcluded.concat(temporarilyExcluded);
    if ( allExcluded.length === 0 ) { return; }
    addRules.unshift({
        action: { type: 'allow' },
        condition: {
            requestDomains: allExcluded,
            resourceTypes: [ 'main_frame' ],
        },
        priority: STRICTBLOCK_PRIORITY,
    });
    ublockPlusLog(`Add 1 DNR session rule with ${allExcluded.length} for excluded strict-block domains`);
}

async function excludeFromStrictBlock(hostname, permanent) {
    if ( typeof hostname !== 'string' || hostname === '' ) { return; }
    const readFn = permanent ? localRead : sessionRead;
    const hostnames = new Set(await readFn('excludedStrictBlockHostnames'));
    hostnames.add(hostname);
    const writeFn = permanent ? localWrite : sessionWrite;
    await writeFn('excludedStrictBlockHostnames', Array.from(hostnames));
    return updateSessionRules();
}

async function setStrictBlockMode(state, force = false) {
    const newState = Boolean(state);
    if ( force === false ) {
        if ( newState === rulesetConfig.strictBlockMode ) { return; }
    }
    rulesetConfig.strictBlockMode = newState;
    const promises = [ saveRulesetConfig() ];
    if ( newState === false ) {
        promises.push(
            localRemove('excludedStrictBlockHostnames'),
            sessionRemove('excludedStrictBlockHostnames')
        );
    }
    await Promise.all(promises);
    return updateSessionRules();
}

/******************************************************************************/

async function updateSessionRulesNow() {
    const addRulesUnfiltered = [];
    const removeRuleIds = [];
    const currentRules = await dnr.getSessionRules();
    await updateStrictBlockRules(currentRules, addRulesUnfiltered, removeRuleIds);
    if ( addRulesUnfiltered.length === 0 && removeRuleIds.length === 0 ) { return; }
    // Chromium accounts dynamic and session regex rules against one shared
    // pool. Use the exact remaining capacity; a synthetic 5% reserve silently
    // discarded valid strict-block rules without protecting another owner.
    const maxRegexCount = Number.isSafeInteger(
        dnr.MAX_NUMBER_OF_REGEX_RULES
    ) ? dnr.MAX_NUMBER_OF_REGEX_RULES : Number.MAX_SAFE_INTEGER;
    const dynamicRegexCount = await getDynamicRegexRuleCount();
    let sessionRegexCount = 0;
    let ruleId = 1;
    for ( const rule of addRulesUnfiltered ) {
        rule.id = ruleId++;
        if ( Boolean(rule.condition.regexFilter) === false ) { continue; }
        if ( dynamicRegexCount + sessionRegexCount >= maxRegexCount ) {
            rule.id = 0;
            continue;
        }
        sessionRegexCount += 1;
    }
    const addRules = addRulesUnfiltered.filter(a => a.id !== 0);
    const rejectedRuleCount = addRulesUnfiltered.length - addRules.length;
    if ( rejectedRuleCount !== 0 ) {
        ublockPlusLog(`Too many regex-based filters, ${rejectedRuleCount} session rules dropped`);
    }
    if ( sessionRegexCount !== 0 ) {
        ublockPlusLog(`Using ${dynamicRegexCount + sessionRegexCount}/${maxRegexCount} shared dynamic/session regex-based DNR rules`);
    }
    const response = { droppedRegexRules: rejectedRuleCount };
    try {
        await dnr.updateSessionRules({ addRules, removeRuleIds });
        if ( removeRuleIds.length !== 0 ) {
            ublockPlusLog(`Remove ${removeRuleIds.length} session DNR rules`);
        }
        if ( addRules.length !== 0 ) {
            ublockPlusLog(`Add ${addRules.length} session DNR rules`);
        }
    } catch(reason) {
        ublockPlusErr(`updateSessionRules/${reason}`);
        response.error = `${reason}`;
    }
    return response;
}

function updateSessionRules() {
    return enqueueDNRMutation(async ( ) => {
        try {
            return await updateSessionRulesNow();
        } catch ( reason ) {
            ublockPlusErr(`updateSessionRules/${reason}`);
            return { error: `${reason}` };
        }
    });
}

async function filteringModesToDNRNow(modes) {
    const noneHostnames = new Set([ ...modes.none ]);
    const notNoneHostnames = new Set([ ...modes.basic, ...modes.optimal, ...modes.complete ]);
    const requestDomains = [];
    const excludedRequestDomains = [];
    const allowEverywhere = noneHostnames.has('all-urls');
    if ( allowEverywhere ) {
        excludedRequestDomains.push(...notNoneHostnames);
    } else {
        requestDomains.push(...noneHostnames);
    }
    const noneCount = allowEverywhere
        ? notNoneHostnames.size
        : noneHostnames.size;
    return dnr.setAllowAllRules(
        TRUSTED_DIRECTIVE_BASE_RULE_ID,
        requestDomains.sort(),
        excludedRequestDomains.sort(),
        allowEverywhere,
        TRUSTED_DIRECTIVE_PRIORITY
    ).then(modified => {
        if ( modified === false ) { return; }
        ublockPlusLog(`${allowEverywhere ? 'Enabled' : 'Disabled'} DNR filtering for ${noneCount} sites`);
    });
}

function filteringModesToDNR(modes) {
    return enqueueDNRMutation(( ) => filteringModesToDNRNow(modes));
}

/******************************************************************************/

export async function getDefaultRulesetsFromEnv() {
    const dropCountry = lang => {
        const pos = lang.indexOf('-');
        if ( pos === -1 ) { return lang; }
        return lang.slice(0, pos);
    };

    const langSet = new Set();

    for ( const lang of navigator.languages.map(dropCountry) ) {
        langSet.add(lang);
    }
    langSet.add(dropCountry(i18n.getUILanguage()));

    const reTargetLang = new RegExp(
        `\\b(${Array.from(langSet).join('|')})\\b`
    );

    const reMobile = /\bMobile\b/.test(navigator.userAgent)
        ? /\bmobile\b/
        : null

    const rulesetDetails = await getRulesetDetails();
    const out = [];
    for ( const ruleset of rulesetDetails.values() ) {
        if ( ruleset.group === 'imported' ) { continue; }
        const { id, enabled } = ruleset;
        if ( enabled ) {
            out.push(id);
            continue;
        }
        if ( typeof ruleset.lang === 'string' ) {
            if ( reTargetLang.test(ruleset.lang) ) {
                out.push(id);
                continue;
            }
        }
        if ( typeof ruleset.tags === 'string' ) {
            if ( reMobile?.test(ruleset.tags) ) {
                out.push(id);
                continue;
            }
        }
    }
   
    return out;
}

/******************************************************************************/

export async function patchDefaultRulesets() {
    const [
        oldDefaultIds = [],
        newDefaultIds,
        staticRulesetIds,
    ] = await Promise.all([
        localRead('defaultRulesetIds'),
        getDefaultRulesetsFromEnv(),
        getStaticRulesets().then(a => a.map(a => a.id)),
    ]);
    const toAdd = [];
    const toRemove = [];
    // New default rulesets to add
    for ( const id of newDefaultIds ) {
        if ( oldDefaultIds.includes(id) ) { continue; }
        toAdd.push(id);
    }
    // Old default rulesets to remove
    for ( const id of oldDefaultIds ) {
        if ( newDefaultIds.includes(id) ) { continue; }
        toRemove.push(id);
    }
    // Non-default rulesets removed from stock lists
    const removedStockLists = new Map([
        [ 'dpollock-0', {
            name: 'Dan Pollock’s hosts file',
            url: 'https://someonewhocares.org/hosts/hosts',
            homeURL: 'https://someonewhocares.org/hosts/',
        }],
    ]);
    const reImported = /^[a-z]+:\/\//;
    const importedToAdd = [];
    for ( const id of rulesetConfig.enabledRulesets ) {
        if ( reImported.test(id) ) { continue; }
        if ( staticRulesetIds.includes(id) ) { continue; }
        if ( toRemove.includes(id) ) { continue; }
        if ( toAdd.includes(id) ) { continue; }
        toRemove.push(id);
        if ( removedStockLists.has(id) ) {
            importedToAdd.push(removedStockLists.get(id));
        }
    }
    if ( importedToAdd.length ) {
        await addImportedLists(importedToAdd);
        toAdd.push(...importedToAdd.map(a => a.url));
    }
    localWrite('defaultRulesetIds', newDefaultIds);
    if ( toAdd.length === 0 && toRemove.length === 0 ) { return; }
    const enabledRulesets = new Set(rulesetConfig.enabledRulesets);
    toAdd.forEach(id => enabledRulesets.add(id));
    toRemove.forEach(id => enabledRulesets.delete(id));
    const patchedRulesets = Array.from(enabledRulesets);
    ublockPlusLog(`Patched rulesets: ${rulesetConfig.enabledRulesets} => ${patchedRulesets}`);
    rulesetConfig.enabledRulesets = patchedRulesets;
}

/******************************************************************************/

export async function getEnabledRulesets() {
    const [
        stockRulesets,
        importedLists,
    ] = await Promise.all([
        dnr.getEnabledRulesets(),
        getEnabledImportedLists(),
    ]);
    return stockRulesets.concat(importedLists.map(a => a.id));
}

/******************************************************************************/

export async function getRulesetRules(id) {
    const rulesetDetails = await getRulesetDetails();
    const ruleset = rulesetDetails.get(id);
    if ( ruleset === undefined ) { return; }
    if ( /^[a-z-]+:\/\//.test(id) ) {
        const cached = await localRead(`rulesets.imported.compiled.${id}`);
        const serialized = typeof cached === 'string'
            ? cached
            : cached?.serialized;
        return { serialized };
    }
    if ( Boolean(ruleset.rules) === false ) { return; }
    const { total, regex } = ruleset.rules;
    const promises = [];
    if ( total !== regex ) {
        promises.push(fetchJSON(`/rulesets/main/${id}`));
    }
    if ( regex ) {
        promises.push(fetchJSON(`/rulesets/regex/${id}`));
    }
    const result = await Promise.all(promises);
    return { rules: result.flat() };
}

/******************************************************************************/

async function updateEnabledRulesets(toEnable, toDisable, out) {
    const reImported = /^[a-z-]+:\/\//;
    const enableRulesetIds = toEnable.filter(a => reImported.test(a) === false);
    const disableRulesetIds = toDisable.filter(a => reImported.test(a) === false);
    if ( enableRulesetIds.length === 0 ) {
        if ( disableRulesetIds.length === 0 ) { return false; }
    }
    return await dnr.updateEnabledRulesets({
        enableRulesetIds,
        disableRulesetIds,
    }).then(( ) => {
        return true;
    }).catch(reason => {
        ublockPlusErr(`updateEnabledRulesets/${reason}`);
        out.error = `${reason}`;
        return false;
    });
}

/******************************************************************************/

async function enableRulesets(ids) {
    const afterIds = new Set(ids);
    const [
        beforeIds,
        adminIds,
        rulesetDetails,
    ] = await Promise.all([
        getEnabledRulesets().then(ids => new Set(ids)),
        getAdminRulesets(),
        getRulesetDetails(),
    ]);

    for ( const token of adminIds ) {
        const c0 = token.charAt(0);
        const id = token.slice(1);
        if ( c0 === '+' ) {
            afterIds.add(id);
        } else if ( c0 === '-' ) {
            afterIds.delete(id);
        }
    }

    const enableRulesetSet = new Set();
    const disableRulesetSet = new Set();
    for ( const id of afterIds ) {
        if ( beforeIds.has(id) ) { continue; }
        enableRulesetSet.add(id);
    }
    for ( const id of beforeIds ) {
        if ( afterIds.has(id) ) { continue; }
        disableRulesetSet.add(id);
    }

    const response = {};

    // Be sure the rulesets to enable/disable do exist in the current version,
    // otherwise the API throws.
    for ( const id of enableRulesetSet ) {
        if ( rulesetDetails.has(id) ) { continue; }
        enableRulesetSet.delete(id);
        if ( /^[a-z-]+:\/\//.test(id) ) {
            response.importedUpdated = true;
        } else {
            response.stockUpdated = true;
        }
    }
    for ( const id of disableRulesetSet ) {
        if ( rulesetDetails.has(id) ) { continue; }
        disableRulesetSet.delete(id);
    }

    const enableRulesetIds = Array.from(enableRulesetSet);
    const disableRulesetIds = Array.from(disableRulesetSet);

    if ( enableRulesetIds.length !== 0 ) {
        ublockPlusLog(`Enable rulesets: ${enableRulesetIds}`);
    }
    if ( disableRulesetIds.length !== 0 ) {
        ublockPlusLog(`Disable ruleset: ${disableRulesetIds}`);
    }

    response.stockUpdated = await updateEnabledRulesets(
        enableRulesetIds,
        disableRulesetIds,
        response,
    ) || response.stockUpdated;
    if ( response.stockUpdated ) {
        const result = await updateDynamicAndSessionRules();
        if ( result?.error ) {
            response.error ||= result.error;
        }
        response.changed = true;
    }

    response.importedUpdated ||= await updateEnabledImportedLists(
        enableRulesetIds,
        disableRulesetIds
    );
    if ( response.importedUpdated ) {
        response.changed = true;
    }

    await getEnabledRulesets().then(enabledRulesets => {
        ublockPlusLog(`Enabled rulesets: ${enabledRulesets}`);
        response.enabledRulesets = enabledRulesets;
        return dnr.getAvailableStaticRuleCount();
    }).then(count => {
        ublockPlusLog(`Available static rule count: ${count}`);
        response.staticRuleCount = count;
    }).catch(reason => {
        ublockPlusErr(`getEnabledRulesets/${reason}`);
    });

    return response;
}

/******************************************************************************/

async function getStaticRulesets() {
    const manifest = runtime.getManifest();
    return manifest.declarative_net_request.rule_resources;
}

/******************************************************************************/

async function getEnabledRulesetsDetails(stockOnly = false) {
    const [
        rulesetIds,
        rulesetDetails,
    ] = await Promise.all([
        getEnabledRulesets(),
        getRulesetDetails(),
    ]);
    const reImported = /^[a-z-]+:\/\//;
    const out = [];
    for ( const id of rulesetIds ) {
        if ( stockOnly && reImported.test(id) ) { continue; }
        const ruleset = rulesetDetails.get(id);
        if ( ruleset === undefined ) { continue; }
        out.push(ruleset);
    }
    return out;
}

/******************************************************************************/

async function getEffectiveUserRules() {
    const allRules = await dnr.getDynamicRules();
    const userRules = [];
    for ( const rule of allRules ) {
        if ( rule.id < USER_RULES_BASE_RULE_ID ) { continue; }
        userRules.push(rule);
    }
    return userRules;
}

async function updateUserRulesNow(generation) {
    // Keep only ids from the existing dynamic rules before loading compiled
    // filter arrays. Holding all three large representations at once causes a
    // pronounced peak in a MV3 service worker on low-memory devices.
    let removeRuleIds;
    let retainedDynamicRegexCount = 0;
    let previousUserRegexCount = 0;
    {
        const currentRules = await dnr.getDynamicRules();
        removeRuleIds = [];
        for ( const rule of currentRules ) {
            if ( rule.id >= USER_RULES_BASE_RULE_ID ) {
                removeRuleIds.push(rule.id);
                if ( rule.condition?.regexFilter ) {
                    previousUserRegexCount += 1;
                }
            } else if ( rule.condition?.regexFilter ) {
                retainedDynamicRegexCount += 1;
            }
        }
    }
    const userRulesText = await localRead('userDnrRules') || '';
    const effectiveGeneration = generation === undefined
        ? await localRead(ACTIVE_COMPILED_GENERATION_KEY) || ''
        : generation;

    const effectiveRulesText = rulesetConfig.developerMode
        ? userRulesText
        : '';

    const parsed = rulesFromText(effectiveRulesText);
    const out = { added: 0, removed: 0, errors: [], fatalError: '' };
    if ( parsed.bad.length !== 0 ) {
        // Keep drafts editable, but never activate only their successfully
        // parsed subset: a skipped allow rule could broaden blocking, and an
        // entirely invalid draft could silently remove the last active set.
        const lines = parsed.bad.slice(0, 16).map(index => index + 1).join(', ');
        out.fatalError = `Invalid developer DNR syntax at line(s) ${lines}; ` +
            'the previous rules remain active';
        out.errors.push(out.fatalError);
        return out;
    }
    const { rules } = parsed;
    {
        const sandboxRules = await localRead(compiledStorageKey(
            effectiveGeneration,
            'sandboxFilters.dnrRules'
        ));
        if ( Array.isArray(sandboxRules) ) {
            for ( const rule of sandboxRules ) {
                rules.push(rule);
            }
        }
    }
    // User rules have high priority
    rules.forEach(a => {
        a.priority = (a.priority || 1) + USER_RULES_PRIORITY;
    });
    {
        const importedRules = await localRead(compiledStorageKey(
            effectiveGeneration,
            'importedFilters.dnrRules'
        ));
        if ( Array.isArray(importedRules) ) {
            for ( const rule of importedRules ) {
                rules.push(rule);
            }
        }
    }
    const rejectedRegexes = [];
    const addRules = await pruneInvalidRegexRules('user', rules, rejectedRegexes);

    if ( rejectedRegexes.length !== 0 ) {
        rejectedRegexes.forEach(e =>
            out.errors.push(`regexFilter: ${e.regex} → ${e.reason}`)
        );
    }

    if ( removeRuleIds.length === 0 && addRules.length === 0 ) {
        await localRemove('userDnrRuleCount');
        return out;
    }

    let ruleId = 0;
    for ( const rule of addRules ) {
        rule.id = USER_RULES_BASE_RULE_ID + ruleId++;
    }

    let effectiveRuleCount = removeRuleIds.length;
    const safePlan = toSafeDynamicRules(addRules);
    if ( safePlan.error ) {
        out.fatalError = safePlan.error;
        out.errors.push(out.fatalError);
        return out;
    }
    out.errors.push(...safePlan.warnings);
    const safeAddRules = safePlan.rules;
    const replacementRegexCount = countRegexRules(safeAddRules);
    const projectedDynamicRegexCount =
        retainedDynamicRegexCount + replacementRegexCount;
    const maxRegexCount = Number.isSafeInteger(
        dnr.MAX_NUMBER_OF_REGEX_RULES
    ) ? dnr.MAX_NUMBER_OF_REGEX_RULES : Number.MAX_SAFE_INTEGER;
    if ( projectedDynamicRegexCount > maxRegexCount ) {
        out.fatalError =
            `Dynamic regex plan requires ${projectedDynamicRegexCount}/` +
            `${maxRegexCount} rules; the previous generation remains active`;
        out.errors.push(out.fatalError);
        return out;
    }

    const regexPlanChanged =
        replacementRegexCount !== previousUserRegexCount;
    let displacedSessionRegexRules = [];
    let sessionRegexRemoved = false;
    try {
        if ( regexPlanChanged ) {
            const sessionRules = await dnr.getSessionRules();
            const sessionRegexCount = countRegexRules(sessionRules);
            if ( projectedDynamicRegexCount + sessionRegexCount >
                maxRegexCount ) {
                displacedSessionRegexRules = sessionRules.filter(rule =>
                    Boolean(rule.condition?.regexFilter)
                );
                await dnr.updateSessionRules({
                    removeRuleIds: displacedSessionRegexRules.map(a => a.id),
                });
                sessionRegexRemoved = true;
            }
        }
        // A single DNR update is atomic: if Chrome rejects any added rule or
        // the quota is exhausted, the previously active rules remain intact.
        await dnr.updateDynamicRules({
            removeRuleIds,
            addRules: safeAddRules,
        });
        if ( removeRuleIds.length !== 0 ) {
            ublockPlusLog(`updateUserRules() / Removed ${removeRuleIds.length} dynamic DNR rules`);
        }
        if ( safeAddRules.length !== 0 ) {
            ublockPlusLog(`updateUserRules() / Added ${safeAddRules.length} DNR rules`);
        }
        out.added = safeAddRules.length;
        out.removed = removeRuleIds.length;
        effectiveRuleCount = safeAddRules.length;

        if ( regexPlanChanged ) {
            const sessionResult = await updateSessionRulesNow();
            if ( sessionResult?.error ) {
                out.errors.push(
                    `Session regex rebuild failed: ${sessionResult.error}`
                );
            }
            const displacedBySharedPool = Math.max(
                sessionResult?.droppedRegexRules || 0,
                projectedDynamicRegexCount +
                    displacedSessionRegexRules.length - maxRegexCount,
                0
            );
            if ( displacedBySharedPool > 0 ) {
                out.errors.push(
                    `${displacedBySharedPool} lower-priority ` +
                    `session regex rule(s) could not fit the shared ` +
                    `${maxRegexCount}-rule pool`
                );
            }
        }
    } catch(reason) {
        ublockPlusErr(`updateUserRules/${reason}`);
        out.fatalError = `${reason}`;
        out.errors.push(out.fatalError);
        if ( sessionRegexRemoved && out.added === 0 ) {
            try {
                await dnr.updateSessionRules({
                    addRules: displacedSessionRegexRules,
                });
            } catch ( restoreReason ) {
                out.fatalError +=
                    `; session rollback failed (${restoreReason})`;
                out.errors.push(
                    `Session regex rollback failed: ${restoreReason}`
                );
            }
        }
    } finally {
        try {
            if ( effectiveRuleCount === 0 ) {
                await localRemove('userDnrRuleCount');
            } else {
                await localWrite('userDnrRuleCount', effectiveRuleCount);
            }
        } catch ( reason ) {
            // This counter is informational. A storage failure here must not
            // make an already-atomic DNR update look as though it failed.
            ublockPlusErr(`updateUserRules/count/${reason}`);
        }
    }
    return out;
}

function updateUserRules(generation) {
    return enqueueDNRMutation(( ) => updateUserRulesNow(generation));
}

/******************************************************************************/

export {
    enableRulesets,
    excludeFromStrictBlock,
    filteringModesToDNR,
    getEffectiveUserRules,
    getEnabledRulesetsDetails,
    setStrictBlockMode,
    updateSessionRules,
    updateUserRules,
};
