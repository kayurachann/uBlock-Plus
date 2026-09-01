/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2014-present Raymond Hill

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

import * as sfp from './static-filtering-parser.js';
import punycode from './punycode.js';
import redirectResourceMap from './redirect-resources.js';

/******************************************************************************/

const safeResourceTypes = [
    'main_frame',
    'sub_frame',
    'stylesheet',
    'script',
    'image',
    'font',
    'object',
    'xmlhttprequest',
    'ping',
    'csp_report',
    'media',
    'websocket',
    'other',
];

/******************************************************************************/

const validRedirectResources = (( ) => {
    const out = new Map();
    for ( const [ name, resource ] of redirectResourceMap ) {
        out.set(name, name);
        if ( resource.alias === undefined ) { continue; }
        if ( typeof resource.alias === 'string' ) {
            out.set(resource.alias, name);
            continue;
        }
        if ( Array.isArray(resource.alias) ) {
            for ( const alias of resource.alias ) {
                out.set(alias, name);
            }
        }
    }
    return out;
})();

const isNotEntity = hn => hn.endsWith('.*') === false;

/******************************************************************************/

function toSuperDomain(hn) {
    const pos = hn.indexOf('.');
    if ( pos === -1 ) { return; }
    return hn.slice(pos+1);
}

/******************************************************************************/

function parseHostnameList(iter) {
    const out = {
        included: {
            good: [],
            bad: [],
        },
        excluded: {
            good: [],
            bad: [],
        },
    };
    for ( let { hn, not, bad } of iter ) {
        bad ||= hn.includes('/') || hn.includes('*');
        const hnAscii = bad === false && hn.startsWith('xn--')
            ? punycode.toASCII(hn)
            : hn;
        const destination = not ? out.excluded : out.included;
        if ( bad ) {
            destination.bad.push(hnAscii);
        } else {
            destination.good.push(hnAscii);
        }
    }
    return out;
}

/******************************************************************************/

function ownerFromPropertyPath(root, path) {
    let owner = root;
    let prop = path;
    for (;;) {
        if ( owner instanceof Object === false ) { break; }
        const pos = prop.indexOf('.');
        if ( pos === -1 ) { break; }
        owner = owner[prop.slice(0, pos)];
        prop = prop.slice(pos+1)
    }
    return { owner: owner ?? undefined, prop };
}

/******************************************************************************/

function propertySorter(k, v) {
    if ( k.startsWith('_') ) { return; }
    if ( Array.isArray(v) ) {
        return typeof v[0] === 'string' ? v.sort() : v;
    }
    if ( v instanceof Object ) {
        const sorted = {};
        for ( const kk of Object.keys(v).sort() ) {
            sorted[kk] = v[kk];
        }
        return sorted;
    }
    return v;
}

/******************************************************************************/

function mergeDomains(rules, includeProp, excludeProp) {
    const out = [];
    const distinctRules = new Map();
    for ( const rule of rules ) {
        const { id } = rule;
        if ( rule.condition === undefined ) {
            out.push(rule);
            continue;
        }
        const includes = rule.condition[includeProp];
        rule.condition[includeProp] = undefined;
        const excludes = rule.condition[excludeProp];
        rule.condition[excludeProp] = undefined;
        rule.id = undefined;
        const hash = JSON.stringify(rule, propertySorter);
        const details = distinctRules.get(hash) || { id };
        if ( details.initialized !== true ) {
            details.initialized = true;
            distinctRules.set(hash, details);
        }
        if ( Boolean(includes?.length) === false ) {
            details.includes = [];
        } else if ( details.includes === undefined ) {
            details.includes = includes;
        } else if ( details.includes.length ) {
            for ( const hn of includes ) {
                details.includes.push(hn);
            }
        }
        if ( excludes?.length ) {
            if ( details.excludes === undefined ) {
                details.excludes = excludes;
            } else {
                for ( const hn of excludes ) {
                    details.excludes.push(hn);
                }
            }
        }
    }
    for ( const [ hash, details ] of distinctRules ) {
        const rule = JSON.parse(hash);
        rule.id = details.id;
        if ( details.includes?.length ) {
            rule.condition[includeProp] = Array.from(new Set(details.includes)).sort();
        }
        if ( details.excludes?.length ) {
            rule.condition[excludeProp] = Array.from(new Set(details.excludes)).sort();
        }
        out.push(rule);
    }
    return out;
}

/******************************************************************************/

function mergeArrays(rules, propertyPath, emptyIsAll = false) {
    const out = [];
    const distinctRules = new Map();
    for ( const rule of rules ) {
        const { id } = rule;
        const { owner, prop } = ownerFromPropertyPath(rule, propertyPath);
        if ( owner === undefined ) {
            out.push(rule);
            continue;
        }
        const collection = owner[prop];
        if ( Array.isArray(collection) === false || collection.length === 0 ) {
            if ( emptyIsAll === false ) {
                out.push(rule);
                continue;
            }
        }
        owner[prop] = undefined;
        rule.id = undefined;
        const hash = JSON.stringify(rule, propertySorter);
        const details = distinctRules.get(hash) || { id };
        if ( details.initialized !== true ) {
            details.initialized = true;
            distinctRules.set(hash, details);
        }
        if ( Boolean(collection?.length) === false ) {
            details.collection = [];
        } else if ( details.collection === undefined ) {
            details.collection = collection;
        } else if ( details.collection.length ) {
            for ( const v of collection ) {
                details.collection.push(v);
            }
        }
    }
    for ( const [ hash, { id, collection } ] of distinctRules ) {
        const rule = JSON.parse(hash);
        if ( id ) {
            rule.id = id;
        }
        if ( collection?.length ) {
            const { owner, prop } = ownerFromPropertyPath(rule, propertyPath);
            owner[prop] = Array.from(new Set(collection)).sort();
        }
        out.push(rule);
    }
    return out;
}

/******************************************************************************/

export function minimizeRuleset(rules) {
    rules.forEach(rule => {
        const { condition } = rule;
        if ( condition.excludedResourceTypes ) { return; }
        if ( condition.resourceTypes ) { return; }
        if ( condition.urlFilter ) { return; }
        if ( condition.regexFilter ) { return; }
        condition.excludedResourceTypes = [ 'main_frame' ];
    });
    rules = mergeArrays(rules, 'action.responseHeaders');
    rules = mergeArrays(rules, 'action.redirect.transform.queryTransform.removeParams');
    rules = mergeArrays(rules, 'condition.responseHeaders');
    rules = mergeArrays(rules, 'condition.resourceTypes', true);
    rules = mergeArrays(rules, 'condition.requestMethods', true);
    rules = mergeDomains(rules, 'initiatorDomains', 'excludedInitiatorDomains');
    rules = mergeDomains(rules, 'requestDomains', 'excludedRequestDomains');
    rules = mergeDomains(rules, 'topDomains', 'excludedTopDomains');
    rules.forEach(rule => {
        const { condition } = rule;
        if ( condition.resourceTypes ) { return; }
        if ( condition.excludedResourceTypes?.length !== 1 ) { return; }
        if ( condition.excludedResourceTypes[0] !== 'main_frame' ) { return; }
        delete condition.excludedResourceTypes;
    });
    return rules;
}

/******************************************************************************/

export function minimizeRules(rules) {
    const hostnameListProp = [
        'requestDomains',
        'excludedRequestDomains',
        'initiatorDomains',
        'excludedInitiatorDomains',
    ];
    for ( const rule of rules ) {
        for ( const prop of hostnameListProp ) {
            const hostnames = rule.condition[prop];
            if ( hostnames === undefined ) { continue; }
            if ( hostnames.length === 1 ) { continue; }
            const hnSet = new Set(hostnames);
            for ( let hn of hnSet ) {
                for (;;) {
                    const hnup = toSuperDomain(hn);
                    if ( hnup === undefined ) { break; }
                    if ( hnSet.has(hnup) ) { hnSet.delete(hn); }
                    hn = hnup;
                }
            }
            if ( hnSet.size === hostnames.length ) { continue; }
            rule.condition[prop] = Array.from(hnSet).sort();
        }
    }
    return rules;
}

/******************************************************************************/

function dropEntities(rule, prop) {
    const { condition } = rule;
    if ( condition[prop] === undefined ) { return; }
    const sanitized = condition[prop].filter(a => isNotEntity(a));
    if ( sanitized.length === condition[prop].length ) { return; }
    if ( sanitized.length === 0 ) {
        delete condition[prop];
        return 0;
    }
    condition[prop] = sanitized;
}

/******************************************************************************/

function convertInitiatorDomainsToRequestDomains(rule) {
    if ( rule.condition.initiatorDomains ) {
        rule.condition.requestDomains ??= [];
        rule.condition.requestDomains = [
            ...rule.condition.requestDomains,
            ...rule.condition.initiatorDomains,
        ];
        delete rule.condition.initiatorDomains;
    }
    if ( rule.condition.excludedInitiatorDomains ) {
        rule.condition.excludedRequestDomains ??= [];
        rule.condition.excludedRequestDomains = [
            ...rule.condition.excludedRequestDomains,
            ...rule.condition.excludedInitiatorDomains,
        ];
        delete rule.condition.excludedInitiatorDomains;
    }
}

/******************************************************************************/

// https://github.com/uBlockOrigin/uBOL-home/discussions/736

export function expandRemoveparamsRule(rule0, out) {
    if ( Boolean(rule0.condition.resourceTypes?.includes('main_frame')) === false ) { return; }
    if ( rule0.condition.initiatorDomains === undefined ) { return; }
    if ( rule0.condition.resourceTypes.length === 1 ) {
        convertInitiatorDomainsToRequestDomains(rule0);
        return;
    }
    const rule1 = structuredClone(rule0);
    rule0.condition.resourceTypes = rule0.condition.resourceTypes.filter(a => a !== 'main_frame');
    rule1.condition.resourceTypes = [ 'main_frame' ];
    convertInitiatorDomainsToRequestDomains(rule1);
    out.push(rule1);
}

/******************************************************************************/

const entityOnlyReasonCodes = Object.freeze({
    requestDomains: 'entity-only-request-domains',
    excludedRequestDomains: 'entity-only-excluded-request-domains',
    initiatorDomains: 'entity-only-initiator-domains',
    excludedInitiatorDomains: 'entity-only-excluded-initiator-domains',
});

export function validateRule(rule) {
    const { condition } = rule;
    // "Only one of resourceTypes and excludedResourceTypes should be specified"
    if ( condition.resourceTypes && condition.excludedResourceTypes ) {
        return {
            status: 'rejected',
            reasonCode: 'dnr-resource-types-conflict',
        };
    }
    // "Only one of requestMethods and excludedRequestMethods should be specified"
    if ( condition.requestMethods && condition.excludedRequestMethods ) {
        return {
            status: 'rejected',
            reasonCode: 'dnr-request-methods-conflict',
        };
    }
    // Drop entity-based hostnames. An entity-only condition cannot be
    // represented by DNR; deleting only the inspected property ensures a
    // caller which retains the rejected rule for diagnostics cannot observe
    // an unrelated condition being overwritten.
    for ( const prop of Object.keys(entityOnlyReasonCodes) ) {
        if ( dropEntities(rule, prop) !== 0 ) { continue; }
        return {
            status: 'rejected',
            reasonCode: entityOnlyReasonCodes[prop],
        };
    }
    // regexSubstitution requires regexFilter
    if ( rule.action?.redirect?.regexSubstitution &&
        condition.regexFilter === undefined ) {
        return {
            status: 'rejected',
            reasonCode: 'dnr-regex-substitution-without-regex-filter',
        };
    }
    return { status: 'accepted' };
}

export function validateRules(rules, rejections) {
    const out = [];
    for ( const rule of rules ) {
        const result = validateRule(rule);
        if ( result.status === 'rejected' ) {
            if ( Array.isArray(rejections) ) {
                rejections.push(result);
            }
            continue;
        }
        out.push(rule);
    }
    return out;
}

/******************************************************************************/

// Priority:
//   Removeparam: 1-4
//   Block: 10 (default priority)
//   Redirect: 11-19
//   Excepted redirect: 21-29
//   Allow: 30
//   Block important: 40
//   Redirect important: 41-49

function networkFilterResult(status, details, reasonCode, classification) {
    const result = { status };
    if ( reasonCode ) { result.reasonCode = reasonCode; }
    if ( classification ) { result.classification = classification; }
    if ( status === 'deferred' ) { result.disposition = 'deferred'; }
    if ( Number.isSafeInteger(details.lineNumber) && details.lineNumber > 0 ) {
        result.lineNumber = details.lineNumber;
    }
    return result;
}

function parserErrorReason(parser) {
    for ( const type of parser.getNodeTypes() ) {
        switch ( type ) {
        case sfp.NODE_TYPE_NET_OPTION_NAME_DENYALLOW:
            return 'invalid-denyallow-domain-list';
        case sfp.NODE_TYPE_NET_OPTION_NAME_FROM:
            return 'invalid-from-domain-list';
        case sfp.NODE_TYPE_NET_OPTION_NAME_TO:
            return 'invalid-to-domain-list';
        case sfp.NODE_TYPE_NET_OPTION_NAME_TOP:
            return 'invalid-top-domain-list';
        default:
            break;
        }
    }
    return 'parser-error';
}

/******************************************************************************/

export function parseNetworkFilter(parser, details = {}, out = []) {
    const reject = reasonCode =>
        networkFilterResult('rejected', details, reasonCode);
    if ( parser.isNetworkFilter() === false ) {
        return reject('not-network-filter');
    }
    if ( parser.hasError() ) { return reject(parserErrorReason(parser)); }

    const validResourceTypes = details.resourceTypes ?? safeResourceTypes;
    const rule = {
        action: { type: 'block' },
        condition: { },
    };
    const isException = parser.isException();
    if ( isException ) {
        rule.action.type = 'allow';
    }

    let pattern = parser.getNetPattern();
    if ( parser.isHostnamePattern() ) {
        rule.condition.requestDomains = [ pattern ];
    } else if ( parser.isPlainPattern() || parser.isGenericPattern() ) {
        if ( parser.isLeftHnAnchored() ) {
            pattern = `||${pattern}`;
        } else if ( parser.isLeftAnchored() ) {
            pattern = `|${pattern}`;
        }
        if ( parser.isRightAnchored() ) {
            pattern = `${pattern}|`;
        }
        rule.condition.urlFilter = pattern;
    } else if ( parser.isRegexPattern() ) {
        rule.condition.regexFilter = pattern;
    } else if ( parser.isAnyPattern() === false ) {
        rule.condition.urlFilter = pattern;
    }

    const defaultResourceTypes = new Set();
    const initiatorDomains = new Set();
    const excludedInitiatorDomains = new Set();
    const requestDomains = new Set();
    const excludedRequestDomains = new Set();
    const topDomains = new Set();
    const excludedTopDomains = new Set();
    const requestMethods = new Set();
    const excludedRequestMethods = new Set();
    const resourceTypes = new Set();
    const excludedResourceTypes = new Set();
    const popupKinds = new Set();
    const routedPopupFilters = [];
    let hasDnrResourceTypeOption = false;

    const processResourceType = (resourceType, nodeType) => {
        const not = parser.isNegatedOption(nodeType)
        if ( validResourceTypes.includes(resourceType) === false ) {
            if ( not ) { return; }
        }
        if ( not ) {
            excludedResourceTypes.add(resourceType);
        } else {
            resourceTypes.add(resourceType);
        }
        hasDnrResourceTypeOption = true;
    };

    let subpriority = 0;
    let isImportant = false;

    for ( const type of parser.getNodeTypes() ) {
        switch ( type ) {
        case sfp.NODE_TYPE_NET_OPTION_NAME_1P:
            rule.condition.domainType = parser.isNegatedOption(type)
                ? 'thirdParty'
                : 'firstParty';
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_STRICT1P:
            return reject('unsupported-strict-first-party');
        case sfp.NODE_TYPE_NET_OPTION_NAME_STRICT3P:
            return reject('unsupported-strict-third-party');
        case sfp.NODE_TYPE_NET_OPTION_NAME_BADFILTER:
            return reject('unsupported-badfilter');
        case sfp.NODE_TYPE_NET_OPTION_NAME_CNAME:
            return reject('unsupported-cname');
        case sfp.NODE_TYPE_NET_OPTION_NAME_EHIDE:
            return reject('unsupported-ehide');
        case sfp.NODE_TYPE_NET_OPTION_NAME_GENERICBLOCK:
            return reject('unsupported-genericblock');
        case sfp.NODE_TYPE_NET_OPTION_NAME_GHIDE:
            return reject('unsupported-ghide');
        case sfp.NODE_TYPE_NET_OPTION_NAME_IPADDRESS:
            return reject('unsupported-ipaddress');
        case sfp.NODE_TYPE_NET_OPTION_NAME_REDIRECTRULE:
            return reject('unsupported-redirect-rule');
        case sfp.NODE_TYPE_NET_OPTION_NAME_REPLACE:
            return reject('unsupported-replace');
        case sfp.NODE_TYPE_NET_OPTION_NAME_SHIDE:
            return reject('unsupported-shide');
        case sfp.NODE_TYPE_NET_OPTION_NAME_URLSKIP:
            return reject('unsupported-urlskip');
        case sfp.NODE_TYPE_NET_OPTION_NAME_INLINEFONT:
            return reject('unsupported-inline-font');
        case sfp.NODE_TYPE_NET_OPTION_NAME_INLINESCRIPT:
            return reject('unsupported-inline-script');
        case sfp.NODE_TYPE_NET_OPTION_NAME_WEBRTC:
            return reject('unsupported-webrtc');
        case sfp.NODE_TYPE_NET_OPTION_NAME_POPUNDER:
            if ( parser.isNegatedOption(type) === false ) {
                popupKinds.add('popunder');
            }
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_POPUP:
            if ( parser.isNegatedOption(type) === false ) {
                popupKinds.add('popup');
            }
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_3P:
            rule.condition.domainType = parser.isNegatedOption(type)
                ? 'firstParty'
                : 'thirdParty';
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_ALL:
            validResourceTypes.forEach(a => resourceTypes.add(a));
            hasDnrResourceTypeOption = true;
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_CSP:
            if ( rule.action.responseHeaders ) {
                return reject('response-header-action-conflict');
            }
            rule.action.type = 'modifyHeaders';
            rule.action.responseHeaders = [ {
                header: 'content-security-policy',
                operation: 'append',
                value: parser.getNetOptionValue(type),
            } ];
            defaultResourceTypes.add('main_frame');
            defaultResourceTypes.add('sub_frame');
            defaultResourceTypes.add('object');
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_CSS:
            processResourceType('stylesheet', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_DENYALLOW: {
            const { included, excluded } = parseHostnameList(
                parser.getNetFilterDenyallowOptionIterator()
            );
            if ( excluded.good.length !== 0 || excluded.bad.length !== 0 ) {
                return reject('invalid-denyallow-domain-list');
            }
            if ( included.bad.length !== 0 ) {
                return reject('invalid-denyallow-domain-list');
            }
            if ( included.good.length === 0 ) {
                return reject('empty-denyallow-domain-list');
            }
            for ( const hn of included.good ) {
                excludedRequestDomains.add(hn);
            }
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_DOC:
            processResourceType('main_frame', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_FONT:
            processResourceType('font', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_FRAME:
            processResourceType('sub_frame', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_FROM: {
            const { included, excluded } = parseHostnameList(
                parser.getNetFilterFromOptionIterator()
            );
            if ( included.good.length === 0 ) {
                if ( included.bad.length !== 0 ) {
                    return reject('invalid-from-domain-list');
                }
            }
            if ( excluded.bad.length !== 0 ) {
                return reject('invalid-from-domain-list');
            }
            for ( const hn of included.good ) {
                initiatorDomains.add(hn);
            }
            for ( const hn of excluded.good ) {
                excludedInitiatorDomains.add(hn);
            }
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_RESPONSEHEADER: {
            const details = sfp.parseHeaderValue(parser.getNetOptionValue(type));
            if ( details.bad ) {
                return reject('invalid-response-header');
            }
            const headerInfo = {
                header: details.name,
            };
            if ( details.value !== '' ) {
                if ( details.isRegex ) {
                    return reject('unsupported-response-header-regex');
                }
                headerInfo.values = [ details.value ];
            }
            if ( details.not ) {
                rule.condition.excludedResponseHeaders = [ headerInfo ];
            } else {
                rule.condition.responseHeaders = [ headerInfo ];
            }
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_IMAGE:
            processResourceType('image', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_IMPORTANT:
            isImportant = true;
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_MATCHCASE:
            rule.condition.isUrlFilterCaseSensitive = true;
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_MEDIA:
            processResourceType('media', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_METHOD: {
            const value = parser.getNetOptionValue(type);
            for ( const method of value.toLowerCase().split('|') ) {
                const not = method.charCodeAt(0) === 0x7E /* '~' */;
                if ( not ) {
                    excludedRequestMethods.add(method.slice(1));
                } else {
                    requestMethods.add(method);
                }
            }
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_OBJECT:
            processResourceType('object', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_OTHER:
            processResourceType('other', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_PERMISSIONS:
            if ( rule.action.responseHeaders ) {
                return reject('response-header-action-conflict');
            }
            rule.action.type = 'modifyHeaders';
            rule.action.responseHeaders = [ {
                header: 'permissions-policy',
                operation: 'append',
                value: parser.getNetOptionValue(type),
            } ];
            defaultResourceTypes.add('main_frame');
            defaultResourceTypes.add('sub_frame');
            defaultResourceTypes.add('object');
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_PING:
            processResourceType('ping', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_REASON:
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_REDIRECT: {
            if ( rule.action.type !== 'block' ) {
                return reject('redirect-action-conflict');
            }
            let value = parser.getNetOptionValue(type);
            const match = /:(\d+)$/.exec(value);
            if ( match ) {
                subpriority = Math.min(parseInt(match[1], 10) || 0, 8);
                value = value.slice(0, match.index);
            }
            if ( validRedirectResources.has(value) === false ) {
                return reject('unsupported-redirect-resource');
            }
            rule.action.type = 'redirect';
            rule.action.redirect = {
                extensionPath: `/web_accessible_resources/${validRedirectResources.get(value)}`,
            };
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_REMOVEPARAM: {
            const details = sfp.parseQueryPruneValue(parser.getNetOptionValue(type));
            if ( details.bad ) { return reject('invalid-removeparam'); }
            if ( details.not ) {
                return reject('unsupported-removeparam-negated');
            }
            if ( details.re ) {
                return reject('unsupported-removeparam-regex');
            }
            const removeParams = [];
            if ( details.name ) {
                removeParams.push(details.name);
                if ( rule.condition.urlFilter === undefined ) {
                    if ( rule.condition.regexFilter === undefined ) {
                        rule.condition.urlFilter = `^${details.name}=`;
                    }
                }
            }
            rule.action.type = 'redirect';
            rule.action.redirect = {
                transform: { queryTransform: { removeParams } }
            };
            defaultResourceTypes.add('main_frame');
            defaultResourceTypes.add('sub_frame');
            defaultResourceTypes.add('xmlhttprequest');
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_SCRIPT:
            processResourceType('script', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_TO: {
            const { included, excluded } = parseHostnameList(
                parser.getNetFilterToOptionIterator()
            );
            if ( included.good.length === 0 ) {
                if ( included.bad.length !== 0 ) {
                    return reject('invalid-to-domain-list');
                }
            }
            if ( excluded.bad.length !== 0 ) {
                return reject('invalid-to-domain-list');
            }
            for ( const hn of included.good ) {
                requestDomains.add(hn);
            }
            for ( const hn of excluded.good ) {
                excludedRequestDomains.add(hn);
            }
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_TOP: {
            const { included, excluded } = parseHostnameList(
                parser.getNetFilterTopOptionIterator()
            );
            if ( included.good.length === 0 ) {
                if ( included.bad.length !== 0 ) {
                    return reject('invalid-top-domain-list');
                }
            }
            if ( excluded.bad.length !== 0 ) {
                return reject('invalid-top-domain-list');
            }
            for ( const hn of included.good ) {
                topDomains.add(hn);
            }
            for ( const hn of excluded.good ) {
                excludedTopDomains.add(hn);
            }
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_URLTRANSFORM: {
            const parsed = sfp.parseReplaceByRegexValue(parser.getNetOptionValue(type));
            if ( parsed === undefined ) {
                return reject('invalid-urltransform');
            }
            if ( parsed.re ) {
                return reject('unsupported-urltransform-regex');
            }
            rule.action.type = 'redirect';
            rule.action.redirect = {
                regexSubstitution: parsed.replacement.replace(/\$(\d+)/g, '\\$1'),
            };
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_XHR:
            processResourceType('xmlhttprequest', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_WEBSOCKET:
            processResourceType('websocket', type);
            break;
        default:
            break;
        }
    }
    if ( initiatorDomains.size !== 0 ) {
        rule.condition.initiatorDomains = Array.from(initiatorDomains).sort();
    }
    if ( excludedInitiatorDomains.size !== 0 ) {
        rule.condition.excludedInitiatorDomains = Array.from(excludedInitiatorDomains).sort();
    }
    if ( requestDomains.size !== 0 ) {
        rule.condition.requestDomains = Array.from(requestDomains).sort();
    }
    if ( excludedRequestDomains.size !== 0 ) {
        rule.condition.excludedRequestDomains = Array.from(excludedRequestDomains).sort();
    }
    if ( topDomains.size !== 0 ) {
        rule.condition.topDomains = Array.from(topDomains).sort();
    }
    if ( excludedTopDomains.size !== 0 ) {
        rule.condition.excludedTopDomains = Array.from(excludedTopDomains).sort();
    }
    if ( requestMethods.size !== 0 ) {
        rule.condition.requestMethods = Array.from(requestMethods).sort();
    }
    if ( excludedRequestMethods.size !== 0 ) {
        rule.condition.excludedRequestMethods = Array.from(excludedRequestMethods).sort();
    }

    if ( popupKinds.size !== 0 ) {
        if ( rule.action.type !== 'block' && rule.action.type !== 'allow' ) {
            return reject('popup-action-conflict');
        }
        if ( Array.isArray(details.popupFilters) === false ) {
            return reject('popup-compiler-required');
        }
        for ( const kind of popupKinds ) {
            const popupFilter = {
                schemaVersion: 1,
                routeCode: 'popup-compiler-required',
                kind,
                action: isException ? 'allow' : 'block',
                important: isImportant,
                condition: structuredClone(rule.condition),
            };
            if ( typeof details.listid === 'string' ) {
                popupFilter.listid = details.listid;
            }
            if ( Number.isSafeInteger(details.lineNumber) &&
                details.lineNumber > 0 ) {
                popupFilter.lineNumber = details.lineNumber;
            }
            routedPopupFilters.push(popupFilter);
        }
    }

    if ( resourceTypes.size === 0 && excludedResourceTypes.size === 0 ) {
        defaultResourceTypes.forEach(a => resourceTypes.add(a));
    }
    if ( resourceTypes.size !== 0 ) {
        const types = Array.from(resourceTypes).filter(a => a !== '').sort();
        if ( types.length === 0 ) {
            return reject('unsupported-resource-type');
        }
        rule.condition.resourceTypes = types;
    }
    if ( excludedResourceTypes.size !== 0 ) {
        if ( resourceTypes.size !== 0 ) {
            return reject('dnr-resource-types-conflict');
        }
        excludedResourceTypes.add('main_frame');
        rule.condition.excludedResourceTypes = Array.from(excludedResourceTypes).sort();
    }

    const popupOnly = popupKinds.size !== 0 &&
        hasDnrResourceTypeOption === false &&
        defaultResourceTypes.size === 0;
    if ( popupOnly ) {
        details.popupFilters.push(...routedPopupFilters);
        return networkFilterResult(
            'deferred',
            details,
            'popup-runtime-consumer-required',
            'popup-compiler-required'
        );
    }
    let priority = 1;
    if ( rule.action.type === 'block' ) {
        priority = isImportant ? 40 : 10;
    } else if ( rule.action.type === 'allow' ) {
        priority = 30;
    } else if ( rule.action.type === 'redirect' ) {
        if ( rule.action.redirect.extensionPath ) {
            if ( isException ) {
                rule.action.type = 'block';
                delete rule.action.redirect;
                priority = 20;
            } else {
                priority = (isImportant ? 41 : 11) + subpriority;
            }
        } else if ( rule.action.redirect.transform?.queryTransform?.removeParams ) {
            if ( isException ) {
                rule.action.type = 'allow';
                delete rule.action.redirect;
            }
        } else if ( rule.action.redirect.regexSubstitution ) {
        }
    } else if ( rule.action.type === 'modifyHeaders' ) {
        if ( isException ) {
            rule.action.type = 'allow';
            delete rule.action.responseHeaders;
        }
    }
    if ( priority !== 1 ) {
        rule.priority = priority;
    }
    const parsedRules = [ rule ];
    if ( rule.action.redirect?.transform?.queryTransform?.removeParams ) {
        expandRemoveparamsRule(rule, parsedRules);
    }
    for ( const parsedRule of parsedRules ) {
        const validation = validateRule(parsedRule);
        if ( validation.status === 'rejected' ) {
            return reject(validation.reasonCode);
        }
    }
    out.push(...parsedRules);
    if ( routedPopupFilters.length !== 0 ) {
        details.popupFilters.push(...routedPopupFilters);
    }
    return networkFilterResult(
        popupKinds.size === 0 ? 'accepted' : 'deferred',
        details,
        popupKinds.size === 0
            ? undefined
            : 'popup-runtime-consumer-required',
        popupKinds.size === 0
            ? 'dnr'
            : 'popup-compiler-required'
    );
}

/******************************************************************************/

export class NetworkFilterCompiler {
    constructor(details = {}) {
        this.details = { ...details };
        this.dnrRules = [];
        this.popupFilters = [];
        this.rejections = [];
        this.filterStats = {
            total: 0,
            accepted: 0,
            rejected: 0,
            routed: 0,
            deferred: 0,
        };
    }

    add(parser, lineNumber) {
        this.filterStats.total += 1;
        const lineRules = [];
        const result = parseNetworkFilter(parser, {
            ...this.details,
            lineNumber,
            popupFilters: this.popupFilters,
        }, lineRules);
        if ( result.status === 'rejected' ) {
            this.filterStats.rejected += 1;
            this.rejections.push(result);
            return result;
        }
        if ( result.status === 'deferred' ) {
            this.filterStats.routed += 1;
            this.filterStats.deferred += 1;
            this.rejections.push(result);
            if ( lineRules.length === 0 ) {
                this.filterStats.rejected += 1;
                return result;
            }
        }
        this.filterStats.accepted += 1;
        this.dnrRules.push(...lineRules);
        return result;
    }

    finish() {
        let dnrRules = minimizeRuleset(this.dnrRules);
        dnrRules = minimizeRules(dnrRules);
        const finalRejections = [];
        const validatedRules = validateRules(dnrRules, finalRejections);
        if ( finalRejections.length !== 0 ) {
            const reasons = Array.from(new Set(
                finalRejections.map(a => a.reasonCode)
            )).sort();
            throw new TypeError(
                `Internal DNR validation failed: ${reasons.join(',')}`
            );
        }
        return {
            filterStats: this.filterStats,
            dnrRules: validatedRules,
            popupFilters: this.popupFilters,
            rejections: this.rejections,
        };
    }
}

/******************************************************************************/

export function parseFilters(text, details) {
    if ( text.startsWith('---') ) { return; }
    if ( text.endsWith('---') ) { return; }
    const lines = text.split(/\n/);
    if ( lines.some(a => a.startsWith(' ')) ) { return; }
    const parser = new sfp.AstFilterParser({ trustedSource: true });
    const compiler = new NetworkFilterCompiler(details);
    for ( let i = 0; i < lines.length; i++ ) {
        const line = lines[i];
        parser.parse(line);
        if ( parser.isNetworkFilter() === false ) { continue; }
        compiler.add(parser, i + 1);
    }
    return compiler.finish().dnrRules;
}
