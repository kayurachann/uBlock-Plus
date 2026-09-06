/*******************************************************************************
    uBlock Plus+ - durable snapshots of installed filtering state
    Copyright (C) 2026-present uBlock Plus+ contributors; GPL-3.0-or-later
******************************************************************************/

import {
    STOCK_BADFILTER_JOURNAL,
    STOCK_BADFILTER_STATE,
    STOCK_BADFILTER_STATUS,
} from './stock-badfilter.js';

const ownsDynamic = rule => rule.id > 0 &&
    (rule.id < 5000000 || rule.id >= 9000000);
const regexCount = rules => rules.filter(rule => rule.condition?.regexFilter).length;
const sameRules = (a, b) => JSON.stringify(a.slice().sort((x, y) => x.id - y.id)) ===
    JSON.stringify(b.slice().sort((x, y) => x.id - y.id));

export function createRulesetNativeState({ dnr, read, write, remove,
    getPackageState, ownsSession }) {
    const snapshot = async ( ) => {
        const packageState = await getPackageState();
        const [ enabledRulesets, dynamicRules, sessionRules, disabledStaticRules,
            managed, status ] = await Promise.all([
            dnr.getEnabledRulesets(), dnr.getDynamicRules(), dnr.getSessionRules(),
            Promise.all(packageState.resources.map(async ({ id }) => ({
                id, ids: await dnr.getDisabledRuleIds({ rulesetId: id }),
            }))),
            read(STOCK_BADFILTER_STATE), read(STOCK_BADFILTER_STATUS),
            ]);
        return {
            schemaVersion: 1, packageState, enabledRulesets,
            dynamicRules: dynamicRules.filter(ownsDynamic),
            sessionRules: sessionRules.filter(ownsSession),
            // Older stock updates could displace another owner's regex rules.
            // Restore a missing rule, but never overwrite a live owner's edit.
            otherSessionRegexRules: sessionRules.filter(rule =>
                ownsSession(rule) === false && Boolean(rule.condition?.regexFilter)),
            disabledStaticRules, managed: managed ?? null, status: status ?? null,
        };
    };
    const restore = async state => {
        if ( state?.schemaVersion !== 1 ||
            Array.isArray(state.enabledRulesets) === false ||
            Array.isArray(state.dynamicRules) === false || state.dynamicRules.every(ownsDynamic) === false ||
            Array.isArray(state.sessionRules) === false || state.sessionRules.every(ownsSession) === false ||
            Array.isArray(state.otherSessionRegexRules) === false ||
            state.otherSessionRegexRules.some(rule => ownsSession(rule) || !rule.condition?.regexFilter) ||
            Array.isArray(state.disabledStaticRules) === false ) {
            throw new Error('Invalid native ruleset recovery snapshot');
        }
        const packageState = await getPackageState();
        if ( JSON.stringify(state.packageState) !== JSON.stringify(packageState) ) {
            // Static numeric IDs can refer to different predicates after an
            // extension update. Leave the journal pending for explicit repair.
            throw new Error('Native ruleset recovery belongs to a different package; old static IDs were not replayed');
        }
        const declared = new Set(packageState.resources.map(resource => resource.id));
        if ( state.enabledRulesets.some(id => declared.has(id) === false) ||
            state.disabledStaticRules.length !== declared.size ||
            new Set(state.disabledStaticRules.map(item => item.id)).size !== declared.size ||
            state.disabledStaticRules.some(item => declared.has(item.id) === false ||
                Array.isArray(item.ids) === false || item.ids.some(id =>
                    Number.isSafeInteger(id) === false || id < 1)) ) {
            throw new Error('Invalid static ruleset recovery snapshot');
        }
        const [ currentDynamic, currentSession, currentEnabled ] = await Promise.all([
            dnr.getDynamicRules(), dnr.getSessionRules(), dnr.getEnabledRulesets(),
        ]);
        const retainedDynamic = currentDynamic.filter(rule => ownsDynamic(rule) === false);
        const retainedSession = currentSession.filter(rule => ownsSession(rule) === false);
        const retainedIds = new Set(retainedSession.map(rule => rule.id));
        const missingSession = state.otherSessionRegexRules.filter(rule => retainedIds.has(rule.id) === false);
        const finalSession = [ ...state.sessionRules, ...retainedSession, ...missingSession ];
        const count = regexCount(state.dynamicRules) + regexCount(retainedDynamic) + regexCount(finalSession);
        const maximum = dnr.MAX_NUMBER_OF_REGEX_RULES ?? Number.MAX_SAFE_INTEGER;
        if ( count > maximum ) {
            throw new Error(`Native ruleset recovery requires ${count}/${maximum} shared regex rules; unrelated rules were preserved`);
        }
        const dynamicChanged = sameRules(currentDynamic.filter(ownsDynamic), state.dynamicRules) === false;
        const sessionChanged = sameRules(currentSession.filter(ownsSession), state.sessionRules) === false;
        if ( dynamicChanged || sessionChanged ) {
            // Across separate native APIs, temporary absence of blocks is safer
            // than keeping a target list active without its matching exceptions.
            if ( currentEnabled.length ) {
                await dnr.updateEnabledRulesets({ disableRulesetIds: currentEnabled });
            }
            const currentOwnedSession = currentSession.filter(ownsSession);
            if ( currentOwnedSession.length ) {
                await dnr.updateSessionRules({ removeRuleIds: currentOwnedSession.map(rule => rule.id) });
            }
            if ( dynamicChanged ) {
                await dnr.updateDynamicRules({
                    removeRuleIds: currentDynamic.filter(ownsDynamic).map(rule => rule.id),
                    addRules: state.dynamicRules,
                });
            }
            if ( state.sessionRules.length || missingSession.length ) {
                await dnr.updateSessionRules({ addRules: [ ...state.sessionRules, ...missingSession ] });
            }
        } else if ( missingSession.length ) {
            await dnr.updateSessionRules({ addRules: missingSession });
        }
        for ( const item of state.disabledStaticRules ) {
            const current = await dnr.getDisabledRuleIds({ rulesetId: item.id });
            const wanted = new Set(item.ids);
            const existing = new Set(current);
            const disableRuleIds = item.ids.filter(id => existing.has(id) === false);
            const enableRuleIds = current.filter(id => wanted.has(id) === false);
            if ( disableRuleIds.length || enableRuleIds.length ) {
                await dnr.updateStaticRules({ rulesetId: item.id, disableRuleIds, enableRuleIds });
            }
        }
        const enabled = await dnr.getEnabledRulesets();
        const wanted = new Set(state.enabledRulesets);
        const existing = new Set(enabled);
        const enableRulesetIds = state.enabledRulesets.filter(id => existing.has(id) === false);
        const disableRulesetIds = enabled.filter(id => wanted.has(id) === false);
        if ( enableRulesetIds.length || disableRulesetIds.length ) {
            await dnr.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
        }
        for ( const [ key, value ] of [ [ STOCK_BADFILTER_STATE, state.managed ],
            [ STOCK_BADFILTER_STATUS, state.status ] ] ) {
            if ( value === null ) { await remove(key); }
            else { await write(key, value); }
        }
        // The outer journal remains authoritative until scripts, configuration
        // and the active compiled generation have also been restored.
    };
    const finalize = ( ) => remove(STOCK_BADFILTER_JOURNAL);
    return { snapshot, restore, finalize };
}
