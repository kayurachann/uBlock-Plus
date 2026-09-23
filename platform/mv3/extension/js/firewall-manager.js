/*******************************************************************************
    uBlock Plus+ - native firewall lifecycle and recovery
    Copyright (C) 2026-present uBlock Plus+ contributors; GPL-3.0-or-later
******************************************************************************/

import {
    FIREWALL_BUDGET_ERROR,
    FIREWALL_RULE_BASE,
    FIREWALL_RULE_LIMIT,
    compileFirewall,
    parseFirewall,
} from './firewall-core.js';
import { explainFirewallRequest } from './firewall-tester.js';

const PERMANENT = 'firewall.permanent';
const SESSION = 'firewall.session';
const PENDING = 'firewall.pending';
const DOMAINS = 'firewall.domains';
const owned = rule => rule.id >= FIREWALL_RULE_BASE &&
    rule.id < FIREWALL_RULE_BASE + FIREWALL_RULE_LIMIT;

export function createFirewallManager(deps) {
    const { dnr, localRead, localWrite, sessionRead, sessionWrite,
        sessionRemove, getModes, log = () => {} } = deps;
    // Injectable only so tests can count compilations on the learning path.
    const compileRules = deps.compileFirewall ?? compileFirewall;
    let supported = false;
    let permanentText = '';
    let sessionText = '';
    let domains = [];
    let resolveDomain;
    // omittedDomains and scopeError describe reduced party coverage only; the
    // configured rules stay active, so they are not reported as `error`.
    let status = { ruleCount: 0, deferredCells: 0, error: '',
        omittedDomains: 0, scopeError: '' };
    let pending = Promise.resolve();
    const enqueue = task => {
        const result = pending.then(task);
        pending = result.catch(() => {});
        return result;
    };
    const domainFromHostname = host => {
        if ( host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host) ||
            host.includes('.') === false ) {
            return host;
        }
        return resolveDomain?.(host) || '';
    };
    const loadDomains = async () => {
        if ( resolveDomain ) { return; }
        resolveDomain = await deps.loadDomainResolver();
    };
    const prepare = async (text, observed = domains, recent = []) => {
        const parsed = parseFirewall(text);
        const candidateDomains = observed.slice();
        const pinned = new Set(recent);
        if ( parsed.rules.length && supported === false ) {
            throw new Error('Dynamic firewall requires Chrome 145+ top-domain conditions');
        }
        if ( parsed.rules.length ) {
            await loadDomains();
            for ( const tab of await deps.getTabs() ) {
                try {
                    const url = new URL(tab.url);
                    if ( [ 'http:', 'https:' ].includes(url.protocol) ) {
                        learn(url.hostname, candidateDomains);
                        pinned.add(domainFromHostname(url.hostname));
                    }
                } catch { /* Restricted URL. */ }
            }
        }
        const current = await dnr.getSessionRules();
        const maximum = Math.min(FIREWALL_RULE_LIMIT,
            (dnr.MAX_NUMBER_OF_SESSION_RULES ?? 5000) - current.filter(r => !owned(r)).length);
        const modes = await getModes();
        const compile = scope => compileRules({ rules: parsed.rules, modes,
            domains: scope, domainFromHostname, maximum });
        let kept = candidateDomains;
        let plan;
        try {
            plan = compile(kept);
        } catch ( reason ) {
            if ( reason?.code !== FIREWALL_BUDGET_ERROR ) { throw reason; }
            // Learned domains only refine party scope. Keep the newest that
            // fit, evicting open tabs and the observed page last, rather than
            // leaving every firewall cell inactive. Without any learned
            // domain the configuration itself is too large: keep old rules.
            const order = [
                ...candidateDomains.filter(domain => pinned.has(domain) === false),
                ...candidateDomains.filter(domain => pinned.has(domain) && recent.includes(domain) === false),
                ...candidateDomains.filter(domain => recent.includes(domain)),
            ];
            const fit = count => {
                const scope = new Set(order.slice(order.length - count));
                const attempt = candidateDomains.filter(domain => scope.has(domain));
                try {
                    return { plan: compile(attempt), kept: attempt };
                } catch ( retry ) {
                    if ( retry?.code !== FIREWALL_BUDGET_ERROR ) { throw retry; }
                }
            };
            // A saturated scope overflows by the one newly observed domain:
            // try dropping only the oldest before searching every size.
            let fitted = order.length ? fit(order.length - 1) : undefined;
            if ( fitted === undefined ) {
                let low = 0;
                let high = order.length - 2;
                while ( low <= high ) {
                    const count = (low + high) >> 1;
                    const attempt = fit(count);
                    if ( attempt ) {
                        fitted = attempt;
                        low = count + 1;
                    } else {
                        high = count - 1;
                    }
                }
            }
            if ( fitted === undefined ) { throw reason; }
            ({ plan, kept } = fitted);
        }
        return { ...plan, text: parsed.text, previous: current.filter(owned), domains: kept,
            omittedDomains: candidateDomains.length - kept.length };
    };
    const activate = async plan => {
        await dnr.updateSessionRules({
            removeRuleIds: plan.previous.map(rule => rule.id), addRules: plan.rules,
        });
        domains = plan.domains;
        status = { ruleCount: plan.rules.length, deferredCells: plan.deferredCells,
            error: '', omittedDomains: plan.omittedDomains, scopeError: '',
            provenance: plan.provenance };
    };
    const getState = () => ({
        supported, permanentText, sessionText, ...status,
        learnedDomains: domains.length,
        temporary: permanentText !== sessionText,
    });
    const refreshNow = async () => {
        try { await activate(await prepare(sessionText)); }
        catch ( reason ) {
            status.error = reason.message;
            log(`Firewall refresh: ${reason.message}`);
            throw reason;
        }
        return getState();
    };
    const learn = (host, into) => {
        const domain = domainFromHostname(host);
        if ( domain === '' || into.includes(domain) ) { return false; }
        into.push(domain);
        if ( into.length > 128 ) { into.shift(); }
        return true;
    };
    return {
        getState,
        testRequest: input => enqueue(async () => {
            await loadDomains();
            return explainFirewallRequest(input, await getModes(), domainFromHostname);
        }),
        initialize: () => enqueue(async () => {
            supported = Object.values(dnr.RuleConditionKeys || {}).includes('topDomains');
            const recovery = await sessionRead(PENDING);
            if ( recovery ) {
                // Recover the previous configuration, including a crash after native
                // activation but before either storage write completed.
                await localWrite(PERMANENT, recovery.permanentText);
                await sessionWrite(SESSION, recovery.sessionText);
            }
            permanentText = (await localRead(PERMANENT)) || '';
            sessionText = (await sessionRead(SESSION)) ?? permanentText;
            domains = (await sessionRead(DOMAINS)) || [];
            domains = domains.filter(host => typeof host === 'string').slice(-128);
            if ( sessionText ) {
                await loadDomains();
            }
            await refreshNow();
            await sessionWrite(DOMAINS, domains);
            await sessionRemove(PENDING);
            return getState();
        }).catch(reason => {
            status.error = reason.message;
            throw reason;
        }),
        preview: text => enqueue(async () => {
            const plan = await prepare(text);
            return { text: plan.text, ruleCount: plan.rules.length,
                deferredCells: plan.deferredCells, omittedDomains: plan.omittedDomains,
                supported };
        }),
        apply: (text, permanent = false) => enqueue(async () => {
            if ( typeof permanent !== 'boolean' ) { throw new Error('Invalid save mode'); }
            const plan = await prepare(text);
            const before = { permanentText, sessionText };
            const oldStatus = structuredClone(status);
            const oldDomains = domains.slice();
            await sessionWrite(PENDING, before);
            let activated = false;
            try {
                await activate(plan);
                activated = true;
                if ( permanent ) { await localWrite(PERMANENT, plan.text); }
                await sessionWrite(SESSION, plan.text);
                await sessionRemove(PENDING);
                if ( permanent ) { permanentText = plan.text; }
                sessionText = plan.text;
                return getState();
            } catch ( reason ) {
                try {
                    if ( activated ) {
                        await dnr.updateSessionRules({
                            removeRuleIds: plan.rules.map(rule => rule.id),
                            addRules: plan.previous,
                        });
                    }
                    await localWrite(PERMANENT, before.permanentText);
                    await sessionWrite(SESSION, before.sessionText);
                    await sessionRemove(PENDING);
                    status = oldStatus;
                    domains = oldDomains;
                } catch ( rollback ) {
                    status.error = `Firewall recovery pending: ${rollback.message}`;
                    throw new Error(`${reason.message}; ${status.error}`);
                }
                throw reason;
            }
        }),
        refresh: () => enqueue(refreshNow),
        observe: url => enqueue(async () => {
            if ( sessionText === '' || supported === false ) { return; }
            let host;
            try {
                const parsed = new URL(url);
                if ( ![ 'http:', 'https:' ].includes(parsed.protocol) ) { return; }
                host = parsed.hostname;
            } catch { return; }
            try {
                await loadDomains();
                const candidateDomains = domains.slice();
                if ( learn(host, candidateDomains) === false ) { return; }
                await activate(await prepare(sessionText, candidateDomains,
                    [ candidateDomains.at(-1) ]));
            } catch ( reason ) {
                // Previously installed rules remain active; report the missing
                // party scope without disabling layers that do not depend on it.
                status.scopeError = reason.message;
                throw reason;
            }
            await sessionWrite(DOMAINS, domains);
        }),
    };
}
