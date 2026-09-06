/*******************************************************************************
    uBlock Plus+ - exact source cancellation for packaged MV3 rules
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later
*******************************************************************************/

export const STOCK_BADFILTER_STATE = 'stockBadfilterState';
export const STOCK_BADFILTER_JOURNAL = 'stockBadfilterJournal';
export const STOCK_BADFILTER_STATUS = 'stockBadfilterStatus';

async function hashSource(key) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export function isStockBadfilterResidualGroup(group) {
    const safeProperties = new Set([ 'requestDomains', 'initiatorDomains',
        'urlFilter', 'resourceTypes', 'excludedResourceTypes',
        'domainType', 'isUrlFilterCaseSensitive' ]);
    if ( group?.property !== 'requestDomains' && group?.property !== 'initiatorDomains' ) { return false; }
    if ( group.template?.action?.type !== 'block' ||
        Object.keys(group.template.action).length !== 1 ||
        Number.isSafeInteger(group.template.priority) === false || group.template.priority < 1 ||
        typeof group.template.condition !== 'object' || group.template.condition === null ||
        group.template.condition[group.property] !== undefined ||
        Object.keys(group.template.condition).some(key => safeProperties.has(key) === false) ||
        Array.isArray(group.domains) === false || group.domains.length === 0 ) { return false; }
    return group.domains.every(entry => Array.isArray(entry) && entry.length === 2 &&
        typeof entry[0] === 'string' && /^[a-z0-9][a-z0-9.-]*$/.test(entry[0]) &&
        Array.isArray(entry[1]) && entry[1].length > 0 && entry[1].every(key =>
            typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)));
}

export function hasExactResidual(rule) {
    if ( rule.complete !== true || Array.isArray(rule.residual) === false ||
        rule.residual.length === 0 || rule.residual.every(isStockBadfilterResidualGroup) === false ) {
        return false;
    }
    const keys = new Set(rule.residual.flatMap(group => group.domains.flatMap(entry => entry[1])));
    return keys.size === new Set(rule.keys).size && rule.keys.every(key => keys.has(key));
}

export function selectStockBadfilterRules(sources, wanted) {
    const deferred = new Set();
    for ( const source of sources ) {
        for ( const key of source.deferredKeys ) {
            if ( wanted.has(key) ) { deferred.add(key); }
        }
    }
    // A source can contribute to multiple compiled rules. If any of those
    // cannot be removed exactly, defer the whole source instead of applying a
    // misleading partial cancellation to just its convenient contributions.
    let changed = true;
    while ( changed ) {
        changed = false;
        for ( const source of sources ) {
            for ( const rule of source.rules ) {
                if ( rule.keys.some(key => wanted.has(key) && deferred.has(key) === false) === false ) { continue; }
                if ( rule.complete && (rule.keys.every(key =>
                    wanted.has(key) && deferred.has(key) === false) || hasExactResidual(rule)) ) { continue; }
                for ( const key of rule.keys ) {
                    if ( wanted.has(key) === false || deferred.has(key) ) { continue; }
                    deferred.add(key);
                    changed = true;
                }
            }
        }
    }
    const selected = {};
    const warnings = [];
    const residualGroups = new Map();
    let deferredRuleCount = 0;
    for ( const source of sources ) {
        const ids = [];
        for ( const rule of source.rules ) {
            if ( rule.keys.some(key => wanted.has(key)) === false ) { continue; }
            if ( rule.complete && rule.keys.every(key =>
                wanted.has(key) && deferred.has(key) === false) ) {
                ids.push(rule.id);
                continue;
            }
            if ( hasExactResidual(rule) && rule.keys.some(key =>
                wanted.has(key) && deferred.has(key) === false) ) {
                ids.push(rule.id);
                for ( const group of rule.residual ) {
                    const remaining = group.domains.filter(entry => entry[1].some(key =>
                        wanted.has(key) === false || deferred.has(key)));
                    if ( remaining.length === 0 ) { continue; }
                    const token = JSON.stringify([ group.property, group.template ]);
                    if ( residualGroups.has(token) === false ) {
                        residualGroups.set(token, { property: group.property,
                            template: group.template, domains: new Set() });
                    }
                    const merged = residualGroups.get(token);
                    for ( const [ hostname ] of remaining ) { merged.domains.add(hostname); }
                }
                continue;
            }
            deferredRuleCount += 1;
            if ( warnings.length < 256 ) {
                warnings.push({ rulesetId: source.id, ruleId: rule.id,
                    reason: 'badfilter-requires-exact-residual-or-secondary-corpus' });
            }
        }
        selected[source.id] = { digest: source.digest, ids };
    }
    const residualRules = Array.from(residualGroups.values(), group => {
        const rule = structuredClone(group.template);
        rule.condition[group.property] = Array.from(group.domains).sort();
        return rule;
    });
    return { selected, residualRules, status: { deferredSourceCount: deferred.size,
        deferredRuleCount, residualRuleCount: residualRules.length, warnings } };
}

function validateSource(id, metadata, index) {
    const validHash = hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
    if ( metadata?.schemaVersion !== 1 ||
        validHash(metadata.digest) === false || metadata.digest !== index.digest ||
        Array.isArray(metadata.deferredKeys) === false ||
        metadata.deferredKeys.every(validHash) === false ||
        Array.isArray(metadata.rules) === false ||
        metadata.rules.every(rule => Number.isSafeInteger(rule.id) && rule.id > 0 &&
            typeof rule.complete === 'boolean' && Array.isArray(rule.keys) &&
            rule.keys.length > 0 && rule.keys.every(validHash) &&
            (rule.residual === undefined || hasExactResidual(rule))) === false ) {
        throw new Error(`Invalid packaged badfilter provenance: ${id}`);
    }
    return { ...metadata, id };
}

export function createStockBadfilterManager({ dnr, read, write, remove, fetchJSON }) {
    const loadIndex = async ( ) => {
        const index = await fetchJSON('/rulesets/badfilter-details');
        if ( index?.schemaVersion !== 1 || typeof index.rulesets !== 'object' ) {
            throw new Error('Packaged badfilter index is unavailable');
        }
        return index.rulesets;
    };
    const restoreStatic = async snapshots => {
        for ( const snapshot of snapshots ) {
            const current = await dnr.getDisabledRuleIds({ rulesetId: snapshot.id });
            const before = new Set(snapshot.ids);
            const now = new Set(current);
            const disableRuleIds = snapshot.ids.filter(id => now.has(id) === false);
            const enableRuleIds = current.filter(id => before.has(id) === false);
            if ( disableRuleIds.length || enableRuleIds.length ) {
                await dnr.updateStaticRules({ rulesetId: snapshot.id,
                    disableRuleIds, enableRuleIds });
            }
        }
    };
    const recover = async ( ) => {
        const journal = await read(STOCK_BADFILTER_JOURNAL);
        if ( journal === undefined || journal === null ) { return; }
        if ( journal.schemaVersion !== 1 || Array.isArray(journal.previous) === false ) {
            throw new Error('Invalid stock badfilter recovery journal');
        }
        const index = await loadIndex();
        if ( journal.previous.some(item => index[item.id]?.digest !== item.digest) ) {
            // Chrome resets disabled static IDs after an extension update.
            // Old numeric IDs must never be replayed into different rule data.
            await remove(STOCK_BADFILTER_STATE);
            await remove(STOCK_BADFILTER_JOURNAL);
            return;
        }
        if ( journal.committed ) {
            await write(STOCK_BADFILTER_STATE, journal.managed);
        } else {
            const current = await dnr.getDynamicRules();
            const sessionRegexes = (await dnr.getSessionRules())
                .filter(rule => Boolean(rule.condition?.regexFilter));
            // Chrome shares the regex quota between dynamic and session
            // rules. The rejected replacement may have rebuilt session rules
            // into space freed by a smaller user plan. Release that space
            // before restoring the old user rules, then restore the old regex
            // session plan. Non-regex session rules (Off/firewall) stay intact.
            if ( sessionRegexes.length ) {
                await dnr.updateSessionRules({ removeRuleIds: sessionRegexes.map(rule => rule.id) });
            }
            await dnr.updateDynamicRules({
                removeRuleIds: current.filter(rule => rule.id >= 9000000).map(rule => rule.id),
                addRules: journal.previousDynamicRules,
            });
            if ( journal.previousSessionRegexRules?.length ) {
                await dnr.updateSessionRules({ addRules: journal.previousSessionRegexRules });
            }
            await restoreStatic(journal.previous);
            await write(STOCK_BADFILTER_STATE, journal.previousManaged);
        }
        await remove(STOCK_BADFILTER_JOURNAL);
    };
    const prepare = async rawKeys => {
        const previousManaged = await read(STOCK_BADFILTER_STATE) ?? {};
        const enabled = await dnr.getEnabledRulesets();
        if ( enabled.length === 0 && Object.keys(previousManaged).length === 0 ) {
            return { previous: [], next: [], previousManaged, managed: {}, changed: false, residualRules: [],
                status: { disabledRuleCount: 0, deferredSourceCount: 0,
                    deferredRuleCount: 0, residualRuleCount: 0, warnings: [] } };
        }
        const index = await loadIndex();
        const allKeys = new Set(rawKeys);
        for ( const id of enabled ) {
            if ( Array.isArray(index[id]?.badfilterKeys) === false ) {
                throw new Error(`Missing packaged badfilter source index: ${id}`);
            }
            for ( const key of index[id].badfilterKeys ) { allKeys.add(key); }
        }
        const wanted = new Set(await Promise.all(Array.from(allKeys, hashSource)));
        const sources = [];
        const disabledSnapshots = new Map();
        if ( wanted.size ) {
            for ( const id of enabled ) {
                const metadata = await fetchJSON(`/rulesets/badfilter/${id}`);
                const source = validateSource(id, metadata, index[id]);
                const ids = await dnr.getDisabledRuleIds({ rulesetId: id });
                disabledSnapshots.set(id, ids);
                const disabled = new Set(ids);
                const owned = new Set(previousManaged[id]?.digest === index[id].digest
                    ? previousManaged[id].ids : []);
                // A rule disabled outside this manager contributes no active
                // predicate. Rebuilding its residual would resurrect blocks
                // which the other owner deliberately disabled.
                source.rules = source.rules.filter(rule =>
                    disabled.has(rule.id) === false || owned.has(rule.id));
                sources.push(source);
            }
        }
        const { selected, residualRules, status } = selectStockBadfilterRules(sources, wanted);
        const previous = [];
        const next = [];
        const managed = {};
        for ( const id of new Set([ ...Object.keys(previousManaged), ...Object.keys(selected) ]) ) {
            if ( index[id] === undefined ) { continue; }
            const ids = disabledSnapshots.get(id) ??
                await dnr.getDisabledRuleIds({ rulesetId: id });
            const oldManaged = previousManaged[id]?.digest === index[id].digest
                ? previousManaged[id].ids : [];
            const desired = selected[id]?.ids ?? [];
            const nextIds = Array.from(new Set([
                ...ids.filter(ruleId => oldManaged.includes(ruleId) === false), ...desired,
            ])).sort((a, b) => a - b);
            previous.push({ id, digest: index[id].digest, ids });
            next.push({ id, digest: index[id].digest, ids: nextIds });
            const owned = desired.filter(ruleId =>
                oldManaged.includes(ruleId) || ids.includes(ruleId) === false);
            if ( owned.length ) { managed[id] = { digest: index[id].digest, ids: owned }; }
        }
        const disabledCount = next.reduce((sum, item) => sum + item.ids.length, 0);
        if ( disabledCount > 5000 ) {
            throw new Error(`Static badfilter plan exceeds Chrome's 5000 disabled-rule limit (${disabledCount})`);
        }
        status.disabledRuleCount = Object.values(managed).reduce((sum, item) => sum + item.ids.length, 0);
        const changed = previous.some((item, i) =>
            JSON.stringify(item.ids.slice().sort((a, b) => a - b)) !== JSON.stringify(next[i].ids));
        return { previous, next, previousManaged, managed, status, changed, residualRules };
    };
    return {
        recover, prepare,
        async begin(plan) {
            const previousDynamicRules = (await dnr.getDynamicRules()).filter(rule => rule.id >= 9000000);
            const previousSessionRegexRules = (await dnr.getSessionRules())
                .filter(rule => Boolean(rule.condition?.regexFilter));
            await write(STOCK_BADFILTER_JOURNAL, { schemaVersion: 1, ...plan,
                previousDynamicRules, previousSessionRegexRules });
        },
        async apply(plan) { await restoreStatic(plan.next); },
        async commit(plan) {
            const journal = await read(STOCK_BADFILTER_JOURNAL);
            await write(STOCK_BADFILTER_JOURNAL, { ...journal, committed: true });
            try {
                await write(STOCK_BADFILTER_STATE, plan.managed);
                await remove(STOCK_BADFILTER_JOURNAL);
            } catch {
                // The durable committed journal is the authority. Finishing
                // its housekeeping can safely wait until the next startup.
            }
        },
        async report(plan) {
            // Reload/update may already have restored the browser's static
            // state. Retire stale ownership even when no native call was needed.
            if ( plan.changed === false ) { await write(STOCK_BADFILTER_STATE, plan.managed); }
            await write(STOCK_BADFILTER_STATUS, plan.status);
        },
    };
}
