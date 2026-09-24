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
    SPECIAL_RULES_REALM,
    TRUSTED_DIRECTIVE_BASE_RULE_ID,
    TRUSTED_DIRECTIVE_PRIORITY,
    USER_RULES_BASE_RULE_ID,
    enqueueDNRMutation,
    setDNRMutationErrorReporter,
} from './dnr-namespaces.js';

import {
    USER_RULES_PRIORITY,
    isStrictBlockSessionRule,
    planStrictBlockSessionRules,
} from './strictblock-rules.js';

import {
    addImportedLists,
    getEnabledImportedLists,
    getImportedLists,
    updateEnabledImportedLists,
} from './imported-lists.js';

import { adminReadEx, getAdminRulesets } from './admin.js';

import {
    i18n,
    localRead, localRemove, localWrite,
    runtime,
    sessionRead, sessionRemove, sessionWrite,
    webextFlavor,
} from './ext.js';

import {
    planUserRegexBudget,
    summarizeRegexCapacity,
} from './regex-capacity.js';

import {
    rulesetConfig,
    saveRulesetConfig,
} from './config.js';
import { ublockPlusErr, ublockPlusLog } from './debug.js';

import { createRulesetNativeState } from './ruleset-native-state.js';
import { createStockBadfilterManager } from './stock-badfilter.js';
import { dnr } from './ext-compat.js';
import { fetchJSON } from './fetch.js';
import { hasBroadHostPermissions } from './ext-utils.js';
import { rulesFromText } from './dnr-parser.js';

/******************************************************************************/

// Developer DNR text installed by the last successful user-rules update.
const USER_DNR_APPLIED_KEY = 'userDnrRules.applied';
// Session storage: the installed strict-block session plan (owners, counts).
const STRICTBLOCK_PLAN_KEY = 'strictBlock.plan';
// Local (permanent) and session (temporary) "don't warn" hostnames.
const STRICTBLOCK_EXCLUSIONS_KEY = 'excludedStrictBlockHostnames';
// Local storage: regex usage per realm of the installed user rules, and the
// last 'Check now' of the packaged static regex rules.
const REGEX_CAPACITY_USER_KEY = 'regexCapacity.user';
const REGEX_CAPACITY_STATIC_KEY = 'regexCapacity.staticCheck';
const DEFAULT_MAX_SESSION_RULES = 5000;
const stockBadfilterManager = createStockBadfilterManager({
    dnr, read: localRead, write: localWrite, remove: localRemove, fetchJSON,
});

// Every dynamic and session DNR write, of every owner, goes through the one
// queue of dnr-namespaces.js. It is re-exported here for the other writers.
setDNRMutationErrorReporter(reason => {
    ublockPlusErr(`DNR transaction queue/${reason}`);
});

function appendDNRResponseError(response, reason) {
    const message = `${reason}`;
    response.error = response.error === undefined
        ? message
        : `${response.error}; ${message}`;
}

async function refreshSessionRules(response = {}, options = {}) {
    try {
        const result = await updateSessionRulesNow(options);
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

// Session rules with IDs 1..999,999 belong to the strict-block plan
// (dnr-namespaces.js); every other session rule belongs to another owner.
const nativeRulesetState = createRulesetNativeState({
    dnr, read: localRead, write: localWrite, remove: localRemove,
    ownsSession: isStrictBlockSessionRule,
    getPackageState: async ( ) => {
        const manifest = runtime.getManifest();
        const index = await fetchJSON('/rulesets/badfilter-details');
        const resources = manifest.declarative_net_request.rule_resources.map(({ id, path }) => {
            const digest = index?.rulesets?.[id]?.digest;
            if ( typeof digest !== 'string' || /^[a-f0-9]{64}$/.test(digest) === false ) {
                throw new Error(`Missing packaged recovery digest: ${id}`);
            }
            return { id, path, digest };
        }).sort((a, b) => a.id.localeCompare(b.id));
        return { version: manifest.version, resources };
    },
});

export function snapshotNativeRulesetState() {
    return enqueueDNRMutation(async ( ) => {
        await stockBadfilterManager.recover();
        const state = await nativeRulesetState.snapshot();
        // The plan describes the snapshot's strict-block session rules: the
        // strict-block page and the logger resolve their IDs through it.
        const plan = await sessionRead(STRICTBLOCK_PLAN_KEY);
        if ( plan?.schemaVersion === 1 ) {
            state.strictBlockPlan = plan;
        }
        return state;
    });
}

export function restoreNativeRulesetState(state) {
    return enqueueDNRMutation(async ( ) => {
        await nativeRulesetState.restore(state);
        // The restored dynamic rules belong to the generation the caller
        // restores as active.
        installedUserGeneration = undefined;
        await storeStrictBlockPlan(state?.strictBlockPlan?.schemaVersion === 1
            ? state.strictBlockPlan
            : undefined
        );
    });
}

export function finalizeNativeRulesetRecovery() {
    return enqueueDNRMutation(( ) => nativeRulesetState.finalize());
}

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

// Chrome compiles a regex with the rule's own matching and capture flags.
const regexOptionsOf = rule => ({
    regex: rule.condition.regexFilter,
    isCaseSensitive: rule.condition.isUrlFilterCaseSensitive === true,
    requireCapturing: rule.action?.redirect?.regexSubstitution !== undefined,
});

// true, or the reason the browser gave. Verdicts are cached per exact
// options for the lifetime of the worker.
async function regexSupport(options) {
    const key = JSON.stringify(options);
    const known = pruneInvalidRegexRules.validated.get(key);
    if ( known !== undefined ) { return known; }
    const result = await dnr.isRegexSupported(options);
    const verdict = result?.isSupported === true
        ? true
        : result?.reason || 'unsupported';
    pruneInvalidRegexRules.validated.set(key, verdict);
    return verdict;
}

async function pruneInvalidRegexRules(realm, rulesIn, rejected = []) {
    // Validate regex-based rules
    const verdicts = await Promise.all(rulesIn.map(rule =>
        rule.condition?.regexFilter === undefined
            ? true
            : regexSupport(regexOptionsOf(rule))
    ));
    const isValid = verdicts.map((verdict, i) => {
        if ( verdict === true ) { return true; }
        rejected.push({ regex: rulesIn[i].condition.regexFilter, reason: verdict });
        return false;
    });

    for ( let i = 0; i < rulesIn.length; i++ ) {
        if ( isValid[i] ) { continue; }
        const rule = rulesIn[i];
        if ( rule.action?.type !== 'allow' &&
            rule.action?.type !== 'allowAllRequests' ) { continue; }
        // An unsupported exception can protect a block from any list in the
        // replacement. Dropping it would silently broaden that block.
        const regex = rule.condition.regexFilter;
        const reason = rejected.find(entry => entry.regex === regex)?.reason || 'unsupported';
        throw new Error(
            `An allow exception uses an unsupported regex (${realm}, rule ${rule.id ?? '?'}, ${reason}): ` +
            `${regex.slice(0, 160)}${regex.length > 160 ? '…' : ''}; ` +
            'the previous rules remain active'
        );
    }

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

const maxRegexRuleCount = ( ) => Number.isSafeInteger(
    dnr.MAX_NUMBER_OF_REGEX_RULES
) ? dnr.MAX_NUMBER_OF_REGEX_RULES : Number.MAX_SAFE_INTEGER;

// Chromium accounts dynamic and session regex rules against one pool. Before
// a dynamic update which needs more of it, the strict-block session regex
// rules make room: they have lower precedence, and the session plan is
// rebuilt into what is left afterwards. Other owners' session rules are
// never displaced. Returns the removed rules, for a rollback.
async function displaceStrictBlockRegexRules(
    dynamicRegexCount, maxRegexCount, sessionRules
) {
    if ( sessionRules === undefined ) {
        sessionRules = await dnr.getSessionRules();
    }
    if ( dynamicRegexCount + countRegexRules(sessionRules) <= maxRegexCount ) {
        return [];
    }
    const displaced = sessionRules.filter(rule =>
        isStrictBlockSessionRule(rule) && Boolean(rule.condition?.regexFilter)
    );
    if ( displaced.length === 0 ) { return []; }
    await dnr.updateSessionRules({
        removeRuleIds: displaced.map(rule => rule.id),
    });
    return displaced;
}

// After a rejected dynamic update: returns the failure reason, if any.
async function restoreDisplacedRegexRules(displaced) {
    if ( displaced.length === 0 ) { return; }
    try {
        await dnr.updateSessionRules({ addRules: displaced });
    } catch ( reason ) {
        return reason;
    }
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
    const maxRegexCount = maxRegexRuleCount();
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
    try {
        if ( dynamicRegexCountAfter !== dynamicRegexCountBefore ) {
            displacedSessionRegexRules = await displaceStrictBlockRegexRules(
                dynamicRegexCountAfter, maxRegexCount
            );
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
        const restoreReason = await restoreDisplacedRegexRules(
            displacedSessionRegexRules
        );
        if ( restoreReason !== undefined ) {
            response.error += `; session rollback failed (${restoreReason})`;
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

// Strict blocking: a blocked top-level document shows strictblock.html
// instead of the browser's error page (classic uBO: "document blocked").
// Session rule IDs 1..999,999 hold the plan of strictblock-rules.js: the
// enabled stock lists' strict-block redirects, redirects for the $doc
// filters of My filters and imported lists, and their exclusion allows. The
// dynamic block of a user $doc filter is never modified: it stays the
// fallback whenever its redirect is not installed.

// The generation whose user rules this worker last installed as dynamic
// rules; unknown after a restart, where the active generation applies.
let installedUserGeneration;
let strictBlockPlanListener;
let strictBlockUrlSourceProvider = ( ) => false;
let strictBlockExclusionProvider = readStoredStrictBlockExclusions;

// Called with the stored plan whenever the installed plan changes.
export function setStrictBlockPlanListener(fn) {
    strictBlockPlanListener = typeof fn === 'function' ? fn : undefined;
}

// A function which returns true while the strict-block page can learn the
// exact blocked address (strictblock-tracker.js). User redirects are only
// installed then; otherwise user $doc filters stay plain blocks.
export function setStrictBlockUrlSourceProvider(fn) {
    strictBlockUrlSourceProvider = typeof fn === 'function' ? fn : ( ) => false;
}

// Where exclusions come from. Per-site switches (roadmap step 3) replace
// the default, which reads the stored "don't warn" hostnames.
export function setStrictBlockExclusionProvider(fn) {
    strictBlockExclusionProvider = typeof fn === 'function'
        ? fn
        : readStoredStrictBlockExclusions;
}

const urlSourceIsExact = ( ) => {
    try {
        return strictBlockUrlSourceProvider() === true;
    } catch {
        return false;
    }
};

async function readStoredStrictBlockExclusions() {
    const [ permanent, temporary ] = await Promise.all([
        localRead(STRICTBLOCK_EXCLUSIONS_KEY),
        sessionRead(STRICTBLOCK_EXCLUSIONS_KEY),
    ]);
    const hosts = [];
    for ( const list of [ permanent, temporary ] ) {
        if ( Array.isArray(list) ) { hosts.push(...list); }
    }
    return { all: false, hosts, layers: [] };
}

// { all, hosts, layers }: `all` turns strict blocking off everywhere, `hosts`
// are excluded with their subdomains, `layers` is reserved for per-site
// switch layers (none yet).
export async function getStrictBlockExclusions() {
    const provided = await strictBlockExclusionProvider();
    const hosts = new Set();
    if ( Array.isArray(provided?.hosts) ) {
        for ( const hostname of provided.hosts ) {
            if ( typeof hostname !== 'string' || hostname === '' ) { continue; }
            hosts.add(hostname.toLowerCase());
        }
    }
    return {
        all: provided?.all === true,
        hosts: Array.from(hosts).sort(),
        layers: Array.isArray(provided?.layers) ? provided.layers : [],
    };
}

export async function isStrictBlockExcluded(hostname) {
    const { all, hosts } = await getStrictBlockExclusions();
    if ( all ) { return true; }
    if ( typeof hostname !== 'string' || hostname === '' ) { return false; }
    const excluded = new Set(hosts);
    let hn = hostname.toLowerCase();
    for (;;) {
        if ( excluded.has(hn) ) { return true; }
        const pos = hn.indexOf('.');
        if ( pos === -1 ) { return false; }
        hn = hn.slice(pos + 1);
    }
}

async function excludeFromStrictBlock(hostname, permanent) {
    if ( typeof hostname !== 'string' || hostname === '' ) { return; }
    const readFn = permanent ? localRead : sessionRead;
    const hostnames = new Set(await readFn(STRICTBLOCK_EXCLUSIONS_KEY));
    hostnames.add(hostname);
    const writeFn = permanent ? localWrite : sessionWrite;
    await writeFn(STRICTBLOCK_EXCLUSIONS_KEY, Array.from(hostnames));
    return updateSessionRules();
}

// Turning strict blocking off, like losing broad host access, only removes
// the redirects: the "don't warn" choices are kept for when it returns.
async function setStrictBlockMode(state, force = false) {
    const newState = Boolean(state);
    if ( force === false ) {
        if ( newState === rulesetConfig.strictBlockMode ) { return; }
    }
    rulesetConfig.strictBlockMode = newState;
    await saveRulesetConfig();
    return updateSessionRules();
}

/******************************************************************************/

function notifyStrictBlockPlan(record) {
    if ( strictBlockPlanListener === undefined ) { return; }
    try {
        strictBlockPlanListener(record ?? { redirectCount: 0, owners: [] });
    } catch ( reason ) {
        ublockPlusErr(`strictBlockPlanListener/${reason}`);
    }
}

async function storeStrictBlockPlan(record) {
    try {
        if ( record === undefined ) {
            await sessionRemove(STRICTBLOCK_PLAN_KEY);
        } else {
            await sessionWrite(STRICTBLOCK_PLAN_KEY, record);
        }
    } catch ( reason ) {
        ublockPlusErr(`strictBlockPlan/${reason}`);
    }
    notifyStrictBlockPlan(record);
}

async function sessionPlanGeneration(generation) {
    if ( typeof generation === 'string' ) { return generation; }
    if ( typeof installedUserGeneration === 'string' ) {
        return installedUserGeneration;
    }
    return await localRead(ACTIVE_COMPILED_GENERATION_KEY) || '';
}

async function readStockStrictBlockRules() {
    const rulesetDetails = (await getEnabledRulesetsDetails(true))
        .filter(details => Boolean(details.rules?.strictblock));
    const rulesets = await Promise.all(rulesetDetails.map(details =>
        fetchJSON(`/rulesets/strictblock/${details.id}`)
    ));
    const out = [];
    for ( let i = 0; i < rulesetDetails.length; i++ ) {
        if ( Array.isArray(rulesets[i]) === false ) { continue; }
        out.push({ rulesetId: rulesetDetails[i].id, rules: rulesets[i] });
    }
    return out;
}

// Redirect templates stored by the compiler next to each realm's dnrRules.
// A generation compiled before they existed has none: plain blocks only.
async function readUserStrictBlockRules(generation) {
    const out = [];
    for ( const realm of [ 'sandbox', 'imported' ] ) {
        const rules = await localRead(compiledStorageKey(
            generation, `${realm}Filters.strictBlockRules`
        ));
        if ( Array.isArray(rules) === false || rules.length === 0 ) { continue; }
        out.push({ realm, rules });
    }
    return out;
}

async function pruneStrictBlockCandidates(entries) {
    let invalid = 0;
    for ( const entry of entries ) {
        const valid = await pruneInvalidRegexRules('strictblock', entry.rules);
        invalid += entry.rules.length - valid.length;
        entry.rules = valid;
    }
    return invalid;
}

// Chrome may return rules with its own key order.
const canonicalRuleJSON = rule => JSON.stringify(rule, (key, value) => {
    if ( value === null || typeof value !== 'object' || Array.isArray(value) ) {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map(k => [ k, value[k] ]));
});

const sameRuleSet = (a, b) => {
    if ( a.length !== b.length ) { return false; }
    const byId = (x, y) => x.id - y.id;
    const right = b.slice().sort(byId);
    return a.slice().sort(byId).every((rule, i) =>
        canonicalRuleJSON(rule) === canonicalRuleJSON(right[i])
    );
};

// Rebuild the strict-block session plan. options.generation: the compiled
// generation whose user rules are installed (default: the one this worker
// installed last, else the active one). options.dynamicRegexCount: the
// installed dynamic regex count, when the caller already knows it.
// A failed update keeps the previous plan and its stored record.
async function updateSessionRulesNow(options = {}) {
    const currentRules = await dnr.getSessionRules();
    const ownedRules = currentRules.filter(isStrictBlockSessionRule);
    const otherRules = currentRules.filter(rule =>
        isStrictBlockSessionRule(rule) === false
    );
    const exclusions = await getStrictBlockExclusions();
    // https://github.com/uBlockOrigin/uBOL-home/issues/428#issuecomment-3172663563
    // https://bugs.webkit.org/show_bug.cgi?id=298199
    // https://developer.apple.com/forums/thread/756214
    const active = rulesetConfig.strictBlockMode !== false &&
        exclusions.all === false && webextFlavor !== 'safari';
    // Strict-block redirects can only be enforced with omnipotence: without
    // host access a redirect shadows the block below it and the page loads.
    const hasOmnipotence = active
        ? await hasBroadHostPermissions().catch(( ) => false)
        : false;
    const generation = await sessionPlanGeneration(options.generation);
    let stock = [];
    let user = [];
    let exactUrlSource = false;
    let stockInvalidRegex = 0;
    let userInvalidRegex = 0;
    if ( active && hasOmnipotence ) {
        stock = await readStockStrictBlockRules();
        stockInvalidRegex = await pruneStrictBlockCandidates(stock);
        if ( webextFlavor === 'chromium' ) {
            exactUrlSource = urlSourceIsExact();
            user = await readUserStrictBlockRules(generation);
        }
    }
    const userCandidates = user.reduce((sum, entry) =>
        sum + entry.rules.length, 0
    );
    if ( exactUrlSource ) {
        userInvalidRegex = await pruneStrictBlockCandidates(user);
    }

    const maxSessionRules = Number.isSafeInteger(dnr.MAX_NUMBER_OF_SESSION_RULES)
        ? dnr.MAX_NUMBER_OF_SESSION_RULES
        : DEFAULT_MAX_SESSION_RULES;
    const maxRegexCount = maxRegexRuleCount();
    const planned = exactUrlSource ? [ ...stock, ...user ] : stock;
    const needsRegex = planned.some(entry =>
        entry.rules.some(rule => Boolean(rule?.condition?.regexFilter))
    );
    let dynamicRegexCount = 0;
    if ( needsRegex ) {
        dynamicRegexCount = Number.isSafeInteger(options.dynamicRegexCount)
            ? options.dynamicRegexCount
            : countRegexRules(await dnr.getDynamicRules());
    }
    const otherRegexCount = countRegexRules(otherRules);
    const plan = planStrictBlockSessionRules({
        flavor: webextFlavor,
        strictBlockMode: active,
        hasOmnipotence,
        exactUrlSource,
        extensionPageURL: runtime.getURL('/strictblock.html'),
        stock,
        user,
        excludedHostnames: exclusions.hosts,
        sessionRuleBudget: maxSessionRules - otherRules.length,
        regexRuleBudget: maxRegexCount - dynamicRegexCount - otherRegexCount,
    });

    const dropped = { ...plan.dropped, stockInvalidRegex, userInvalidRegex };
    const response = {
        droppedRegexRules: plan.dropped.stockRegexPool + plan.dropped.userRegexPool,
        strictBlock: { redirectCount: plan.redirectCount, dropped },
    };
    if ( response.droppedRegexRules !== 0 ) {
        ublockPlusLog(`Too many regex-based filters, ${response.droppedRegexRules} strict-block session rules dropped`);
    }
    const droppedSessionRules = plan.dropped.stockSessionLimit +
        plan.dropped.userSessionLimit;
    if ( droppedSessionRules !== 0 ) {
        ublockPlusLog(`Session rule limit reached, ${droppedSessionRules} strict-block session rules dropped`);
    }
    if ( sameRuleSet(ownedRules, plan.rules) === false ) {
        try {
            await dnr.updateSessionRules({
                removeRuleIds: ownedRules.map(rule => rule.id),
                addRules: plan.rules,
            });
        } catch(reason) {
            ublockPlusErr(`updateSessionRules/${reason}`);
            response.error = `${reason}`;
            return response;
        }
        if ( ownedRules.length !== 0 ) {
            ublockPlusLog(`Remove ${ownedRules.length} strict-block session DNR rules`);
        }
        if ( plan.rules.length !== 0 ) {
            ublockPlusLog(`Add ${plan.rules.length} strict-block session DNR rules (${plan.redirectCount} redirects)`);
        }
        if ( plan.counts.regex !== 0 ) {
            ublockPlusLog(`Using ${dynamicRegexCount + otherRegexCount + plan.counts.regex}/${maxRegexCount} shared dynamic/session regex-based DNR rules`);
        }
    }
    await storeStrictBlockPlan({
        schemaVersion: 1,
        generation,
        // The setting, apart from `strictBlockMode`, which also folds in
        // "exclude everything" and the platform.
        configuredMode: rulesetConfig.strictBlockMode !== false,
        strictBlockMode: active,
        hasOmnipotence,
        exactUrlSource,
        owners: plan.owners,
        counts: plan.counts,
        dropped,
        redirectCount: plan.redirectCount,
        userCandidates,
        builtAt: Date.now(),
    });
    return response;
}

// Queued rebuild of the session plan: the trigger for any owner which changed
// what the plan depends on (dynamic regex usage, exclusions, permissions).
// A task already running in the DNR queue calls updateSessionRulesNow().
function updateSessionRules(options = {}) {
    return enqueueDNRMutation(async ( ) => {
        try {
            return await updateSessionRulesNow(options);
        } catch ( reason ) {
            ublockPlusErr(`updateSessionRules/${reason}`);
            return { error: `${reason}` };
        }
    });
}

// Called on every worker start. Redirects must not outlive the broad host
// access they need, user redirects follow the exact URL source, and a plan
// lost with the session storage is rebuilt.
export async function reconcileStrictBlockSessionRules() {
    const [ plan, hasOmnipotence ] = await Promise.all([
        sessionRead(STRICTBLOCK_PLAN_KEY),
        hasBroadHostPermissions().catch(( ) => false),
    ]);
    const configured = rulesetConfig.strictBlockMode !== false;
    let stale = false;
    if ( plan?.schemaVersion !== 1 ) {
        stale = configured && hasOmnipotence ||
            (await dnr.getSessionRules()).some(isStrictBlockSessionRule);
    } else if ( plan.redirectCount > 0 && hasOmnipotence === false ) {
        stale = true;
    } else if ( (typeof plan.configuredMode === 'boolean'
        ? plan.configuredMode
        : plan.strictBlockMode) !== configured
    ) {
        // Turned off or on, and the worker stopped before the rebuild.
        stale = true;
    } else if ( plan.strictBlockMode && plan.hasOmnipotence !== hasOmnipotence ) {
        stale = true;
    } else if ( plan.userCandidates > 0 &&
        plan.exactUrlSource !== urlSourceIsExact() ) {
        stale = true;
    }
    if ( stale === false ) { return { rebuilt: false, plan }; }
    const result = await updateSessionRules();
    return {
        ...result,
        rebuilt: true,
        plan: await sessionRead(STRICTBLOCK_PLAN_KEY),
    };
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

async function updateUserRulesNow(generation, stockResidualRules, effectiveRulesText) {
    // Keep only ids from the existing dynamic rules before loading compiled
    // filter arrays. Holding all three large representations at once causes a
    // pronounced peak in a MV3 service worker on low-memory devices.
    let removeRuleIds;
    let retainedDynamicRegexCount = 0;
    {
        const currentRules = await dnr.getDynamicRules();
        removeRuleIds = [];
        for ( const rule of currentRules ) {
            if ( rule.id >= USER_RULES_BASE_RULE_ID ) {
                removeRuleIds.push(rule.id);
            } else if ( rule.condition?.regexFilter ) {
                retainedDynamicRegexCount += 1;
            }
        }
    }
    const effectiveGeneration = generation === undefined
        ? await localRead(ACTIVE_COMPILED_GENERATION_KEY) || ''
        : generation;

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
    // The realm of every rule, for the regex overflow policy.
    const ruleOwners = new Map(rules.map(rule => [ rule, 'developer' ]));
    {
        const sandboxRules = await localRead(compiledStorageKey(
            effectiveGeneration,
            'sandboxFilters.dnrRules'
        ));
        if ( Array.isArray(sandboxRules) ) {
            for ( const rule of sandboxRules ) {
                rules.push(rule);
                ruleOwners.set(rule, 'sandbox');
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
                ruleOwners.set(rule, 'imported');
            }
        }
    }
    const rejectedRegexes = [];
    // These are exact original stock predicates reconstructed from packaged
    // source-domain provenance. Keep stock priority and include every residual
    // in the same atomic native update: a quota rejection retains last-good.
    for ( const rule of stockResidualRules ) {
        const residual = structuredClone(rule);
        rules.push(residual);
        ruleOwners.set(residual, 'stock-residual');
    }
    let addRules;
    try {
        addRules = await pruneInvalidRegexRules('user', rules, rejectedRegexes);
    } catch ( reason ) {
        out.fatalError = reason?.message || `${reason}`;
        out.errors.push(out.fatalError);
        return out;
    }

    if ( rejectedRegexes.length !== 0 ) {
        rejectedRegexes.forEach(e =>
            out.errors.push(`regexFilter: ${e.regex} → ${e.reason}`)
        );
    }

    if ( removeRuleIds.length === 0 && addRules.length === 0 ) {
        await localRemove('userDnrRuleCount');
        out.regexUsage = {
            developer: 0, sandbox: 0, imported: 0, stockResidual: 0,
            droppedImported: 0,
        };
        out.dynamicRegexCount = retainedDynamicRegexCount;
        return out;
    }

    let effectiveRuleCount = removeRuleIds.length;
    const safePlan = toSafeDynamicRules(addRules);
    if ( safePlan.error ) {
        out.fatalError = safePlan.error;
        out.errors.push(out.fatalError);
        return out;
    }
    out.errors.push(...safePlan.warnings);

    // Other owners' session regex rules share the pool and are retained;
    // strict-block session regex rules make room and are planned afterwards.
    const maxRegexCount = maxRegexRuleCount();
    const sessionRules = await dnr.getSessionRules();
    const regexPlan = planUserRegexBudget({
        rules: safePlan.rules,
        owners: safePlan.rules.map(rule => ruleOwners.get(rule)),
        retainedRegexCount: retainedDynamicRegexCount + countRegexRules(
            sessionRules.filter(rule => isStrictBlockSessionRule(rule) === false)
        ),
        maxRegexCount,
    });
    ruleOwners.clear();
    if ( regexPlan.fatal ) {
        out.fatalError =
            `Dynamic regex plan requires ${regexPlan.required}/` +
            `${maxRegexCount} rules; the previous generation remains active`;
        out.errors.push(out.fatalError);
        return out;
    }
    if ( regexPlan.droppedImported !== 0 ) {
        out.errors.push(
            `${regexPlan.droppedImported} imported regex rule(s) were not ` +
            `installed: the browser's ${maxRegexCount}-rule regex limit is full`
        );
    }
    const safeAddRules = regexPlan.rules;
    let ruleId = 0;
    for ( const rule of safeAddRules ) {
        rule.id = USER_RULES_BASE_RULE_ID + ruleId++;
    }
    const dynamicRegexCount = retainedDynamicRegexCount +
        countRegexRules(safeAddRules);

    let displacedSessionRegexRules = [];
    try {
        displacedSessionRegexRules = await displaceStrictBlockRegexRules(
            dynamicRegexCount, maxRegexCount, sessionRules
        );
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
        // For the caller, which rebuilds the session plan and records the
        // regex usage once the whole update has committed.
        out.regexUsage = {
            ...regexPlan.counts,
            droppedImported: regexPlan.droppedImported,
        };
        out.dynamicRegexCount = dynamicRegexCount;
    } catch(reason) {
        ublockPlusErr(`updateUserRules/${reason}`);
        out.fatalError = `${reason}`;
        out.errors.push(out.fatalError);
        if ( out.added === 0 ) {
            const restoreReason = await restoreDisplacedRegexRules(
                displacedSessionRegexRules
            );
            if ( restoreReason !== undefined ) {
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

async function recordUserRegexUsage(generation, usage) {
    if ( usage === undefined ) { return; }
    try {
        await localWrite(REGEX_CAPACITY_USER_KEY, {
            schemaVersion: 1,
            generation,
            ...usage,
            updatedAt: Date.now(),
        });
    } catch ( reason ) {
        ublockPlusErr(`updateUserRules/regexCapacity/${reason}`);
    }
}

// The session plan always follows the installed user rules: their $doc
// redirects, and the regex capacity the dynamic rules left.
async function rebuildSessionAfterUserRules(generation, result) {
    const { dynamicRegexCount } = result;
    try {
        const sessionResult = await updateSessionRulesNow({
            generation, dynamicRegexCount,
        });
        if ( sessionResult?.error ) {
            result.errors.push(`Session rule rebuild failed: ${sessionResult.error}`);
        }
        if ( sessionResult?.droppedRegexRules > 0 ) {
            result.errors.push(
                `${sessionResult.droppedRegexRules} lower-priority strict-block ` +
                `regex rule(s) could not fit the shared ` +
                `${maxRegexRuleCount()}-rule pool`
            );
        }
    } catch ( reason ) {
        ublockPlusErr(`updateUserRules/session/${reason}`);
        result.errors.push(`Session rule rebuild failed: ${reason}`);
    }
}

// Only an explicit save (strictDeveloperDraft) may fail because of the saved
// developer draft. Every other update which cannot use the draft keeps the
// developer rules installed by the last successful update, so a draft error
// cannot block unrelated compiled, recovery or startup updates. Without a
// record of those rules (before the first update which stored one), the draft
// error is still returned: guessing could drop an installed exception.
// A managed 'develop' lock treats the draft as empty, so that neither a saved
// nor a restored draft installs developer rules, and earlier ones go away.
async function developerRulesAllowed() {
    if ( rulesetConfig.developerMode !== true ) { return false; }
    const forbidden = await adminReadEx('disabledFeatures');
    return Array.isArray(forbidden) === false || forbidden.includes('develop') === false;
}

async function updateDeveloperUserRulesNow(generation, stockResidualRules, options) {
    const developerRules = await developerRulesAllowed();
    const draftText = developerRules
        ? await localRead('userDnrRules') || ''
        : '';
    const result = await updateUserRulesNow(generation, stockResidualRules, draftText);
    if ( result.fatalError === '' || options.strictDeveloperDraft === true ||
        developerRules !== true ) {
        return { result, developerRulesText: draftText };
    }
    const appliedText = await localRead(USER_DNR_APPLIED_KEY);
    if ( typeof appliedText !== 'string' || appliedText === draftText ) {
        return { result, developerRulesText: draftText };
    }
    const fallback = await updateUserRulesNow(generation, stockResidualRules, appliedText);
    if ( fallback.fatalError === '' ) {
        fallback.errors.unshift(`Developer DNR draft not applied: ${result.fatalError}`);
    }
    return { result: fallback, developerRulesText: appliedText };
}

async function updateUserRulesWithStockNow(generation, options) {
    let plan;
    try {
        await stockBadfilterManager.recover();
        const effectiveGeneration = generation === undefined
            ? await localRead(ACTIVE_COMPILED_GENERATION_KEY) || '' : generation;
        const keys = [];
        for ( const realm of [ 'sandbox', 'imported' ] ) {
            const values = await localRead(compiledStorageKey(effectiveGeneration,
                `${realm}Filters.badfilterKeys`));
            if ( Array.isArray(values) ) { keys.push(...values); }
        }
        plan = await stockBadfilterManager.prepare(keys);
        if ( plan.changed ) { await stockBadfilterManager.begin(plan); }
        const { result, developerRulesText } = await updateDeveloperUserRulesNow(
            generation, plan.residualRules, options
        );
        if ( result.fatalError ) { throw new Error(result.fatalError); }
        if ( plan.changed ) {
            await stockBadfilterManager.apply(plan);
            await stockBadfilterManager.commit(plan);
        }
        // Only now, after the stock badfilter journal committed: its recovery
        // restores the session regex rules it snapshotted, which must not
        // collide with the IDs of a newer plan.
        const { regexUsage } = result;
        delete result.regexUsage;
        installedUserGeneration = effectiveGeneration;
        await recordUserRegexUsage(effectiveGeneration, regexUsage);
        await rebuildSessionAfterUserRules(effectiveGeneration, result);
        delete result.dynamicRegexCount;
        try { await stockBadfilterManager.report(plan); } catch { }
        try {
            if ( await localRead(USER_DNR_APPLIED_KEY) !== developerRulesText ) {
                await localWrite(USER_DNR_APPLIED_KEY, developerRulesText);
            }
        } catch ( reason ) {
            // The native update is committed; only a later fallback can use
            // an older record.
            ublockPlusErr(`updateUserRules/applied/${reason}`);
        }
        if ( plan.status.deferredSourceCount ) {
            result.errors.push(`$badfilter: ${plan.status.deferredSourceCount} packaged source(s) ` +
                'deferred because exact residual or secondary-corpus cancellation is required');
        }
        return result;
    } catch ( reason ) {
        let message = reason?.message ?? `${reason}`;
        try { await stockBadfilterManager.recover(); } catch ( rollbackReason ) {
            message += `; stock badfilter recovery pending: ${rollbackReason?.message ?? rollbackReason}`;
        }
        return { added: 0, removed: 0, errors: [ message ], fatalError: message };
    }
}

function recoverStockBadfilters() {
    return enqueueDNRMutation(( ) => stockBadfilterManager.recover());
}

function updateUserRules(generation, options = {}) {
    return enqueueDNRMutation(( ) =>
        updateUserRulesWithStockNow(generation, options)
    );
}

/******************************************************************************/

// Regex rule capacity (Dashboard > Diagnostics, Filter Store estimate).

async function fetchPackagedJSON(path) {
    try {
        const response = await fetch(path);
        if ( response.ok === false ) { return; }
        return await response.json();
    } catch {
    }
}

const browserMajorVersion = ( ) => {
    const match = /\b(?:Chrome|Firefox)\/(\d+)/.exec(
        globalThis.navigator?.userAgent ?? ''
    );
    return match !== null ? parseInt(match[1], 10) : 0;
};

// 'Check now': ask this browser about every packaged static regex rule of
// the enabled lists. Chrome silently skips a static regex it cannot run
// (for example over its memory limit), so only this check can count them.
// Rulesets are checked one at a time and only their regex rules are kept.
async function verifyStaticRegexRules(enabledRulesetIds, stockRulesets) {
    const manifest = runtime.getManifest();
    const paths = new Map();
    for ( const { id, path } of manifest.declarative_net_request?.rule_resources ?? [] ) {
        paths.set(id, path);
    }
    const expected = new Map(stockRulesets.map(details =>
        [ details.id, details.rules?.regexStatic ]
    ));
    const byRuleset = {};
    const samples = [];
    for ( const id of enabledRulesetIds ) {
        const count = expected.get(id);
        if ( Number.isSafeInteger(count) === false || count <= 0 ) { continue; }
        if ( typeof paths.get(id) !== 'string' ) { continue; }
        const regexRules = await fetchPackagedJSON(paths.get(id)).then(rules =>
            Array.isArray(rules)
                ? rules.filter(rule => Boolean(rule?.condition?.regexFilter))
                : undefined
        );
        // A ruleset which could not be read stays unchecked (unknown).
        if ( regexRules === undefined ) { continue; }
        const verdicts = await Promise.all(regexRules.map(rule =>
            regexSupport(regexOptionsOf(rule))
        ));
        let skipped = 0;
        verdicts.forEach((verdict, i) => {
            if ( verdict === true ) { return; }
            skipped += 1;
            if ( samples.length >= 10 ) { return; }
            samples.push({
                rulesetId: id,
                ruleId: regexRules[i].id,
                regex: regexRules[i].condition.regexFilter.slice(0, 160),
                reason: verdict,
            });
        });
        byRuleset[id] = { checked: regexRules.length, skipped };
    }
    const check = {
        schemaVersion: 1,
        extensionVersion: manifest.version,
        chromeMajor: browserMajorVersion(),
        byRuleset,
        samples,
        checkedAt: Date.now(),
    };
    try {
        await localWrite(REGEX_CAPACITY_STATIC_KEY, check);
    } catch ( reason ) {
        ublockPlusErr(`getRegexCapacity/staticCheck/${reason}`);
    }
    return check;
}

export async function getRegexCapacity({ verifyStatic = false } = {}) {
    const reImported = /^[a-z-]+:\/\//;
    const [
        rulesetDetails,
        regexDetails,
        enabledRulesetIds,
        dynamicRules,
        sessionRules,
        userRecord,
        plan,
        adminIds,
        exclusions,
    ] = await Promise.all([
        getRulesetDetails(),
        fetchPackagedJSON('/rulesets/regex-details.json'),
        dnr.getEnabledRulesets(),
        dnr.getDynamicRules(),
        dnr.getSessionRules(),
        localRead(REGEX_CAPACITY_USER_KEY),
        sessionRead(STRICTBLOCK_PLAN_KEY),
        getAdminRulesets(),
        getStrictBlockExclusions().catch(( ) => undefined),
    ]);
    const stockRulesets = Array.from(rulesetDetails.values())
        .filter(details => reImported.test(details.id) === false);
    const staticCheck = verifyStatic
        ? await verifyStaticRegexRules(enabledRulesetIds, stockRulesets)
        : await localRead(REGEX_CAPACITY_STATIC_KEY);
    // Selected lists, with the admin overrides enableRulesets() applies,
    // which the browser did not enable (for example at its ruleset limit).
    const selected = new Set(rulesetConfig.enabledRulesets);
    for ( const token of adminIds ?? [] ) {
        if ( token.charAt(0) === '+' ) {
            selected.add(token.slice(1));
        } else if ( token.charAt(0) === '-' ) {
            selected.delete(token.slice(1));
        }
    }
    const known = new Set(stockRulesets.map(details => details.id));
    const enabled = new Set(enabledRulesetIds);
    const rulesetsNotEnabled = Array.from(selected).filter(id =>
        known.has(id) && enabled.has(id) === false
    );
    return summarizeRegexCapacity({
        sharedLimit: dnr.MAX_NUMBER_OF_REGEX_RULES,
        dynamicRules,
        sessionRules,
        userRecord,
        plan,
        stockRulesets,
        enabledRulesetIds,
        regexDetails,
        staticCheck,
        extensionVersion: runtime.getManifest().version,
        chromeMajor: browserMajorVersion(),
        rulesetsNotEnabled,
        exclusions,
    });
}

/******************************************************************************/

export {
    enableRulesets,
    enqueueDNRMutation,
    excludeFromStrictBlock,
    filteringModesToDNR,
    getEffectiveUserRules,
    getEnabledRulesetsDetails,
    recoverStockBadfilters,
    setStrictBlockMode,
    updateSessionRules,
    updateSessionRulesNow,
    updateUserRules,
};
