/*******************************************************************************

    uBlock Plus+ - Power UI schema tests
    Copyright (C) 2026-present uBlock Plus+ contributors

*******************************************************************************/

import {
    POWER_PROFILES,
    POWER_UI_DEFAULTS,
    matchingPowerProfile,
    normalizePowerUISettings,
} from '../platform/mv3/extension/js/power-ui-core.js';
import assert from 'node:assert/strict';

assert.deepEqual(normalizePowerUISettings(), POWER_UI_DEFAULTS);

const customUI = normalizePowerUISettings({
    theme: 'dark',
    accent: 'violet',
    density: 'compact',
    popupLayout: 'power',
}, { strict: true });
assert.equal(customUI.theme, 'dark');
assert.equal(customUI.density, 'compact');

for ( const invalid of [
    [],
    'dark',
    { theme: 'midnight' },
    { accent: '#fff' },
    { density: 'tiny' },
    { popupLayout: 'firewall' },
] ) {
    assert.throws(( ) => normalizePowerUISettings(invalid, { strict: true }));
}

for ( const [ name, profile ] of Object.entries(POWER_PROFILES) ) {
    assert.equal(matchingPowerProfile(profile), name);
}
assert.equal(matchingPowerProfile({
    ...POWER_PROFILES.balanced,
    autoReload: false,
}), 'custom');

// Dashboard Power settings: profiles, appearance, Site Rules, diagnostics.
{
    const {
        FakeDocument, FakeElement, createExtension, settle, stageModules,
    } = await import('./dashboard-test-harness.mjs');
    const document = new FakeDocument();
    const status = document.register('#operationStatus');
    const applyButton = document.register('#applyProtectionProfile', new FakeElement('button'));
    const radios = new Map(Object.keys(POWER_PROFILES).map(name => {
        const radio = new FakeElement('input', { value: name });
        document.register(`input[name="powerProfile"][value="${name}"]`, radio);
        document.register('input[name="powerProfile"]', radio);
        return [ name, radio ];
    }));
    document.define('input[name="powerProfile"]:checked', ( ) =>
        [ ...radios.values() ].filter(radio => radio.checked)
    );
    // Like a click on a profile card: one radio of the group is checked.
    const pick = name => {
        for ( const [ key, radio ] of radios ) { radio.checked = key === name; }
    };
    const checkedProfile = ( ) => document.one('input[name="powerProfile"]:checked')?.value;
    const profileLabel = document.register('#protectionProfiles .powerProfileState');
    const appearance = new Map([ 'theme', 'accent', 'density', 'popupLayout' ].map(key => {
        const select = new FakeElement('select');
        select.dataset.powerUi = key;
        document.register('[data-power-ui]', select);
        return [ key, select ];
    }));
    document.register('#popupPolicyRows', new FakeElement('tbody'));
    document.register('#popupPolicyEmpty');
    const textareas = new Map([ 'none', 'basic', 'optimal', 'complete' ].map(mode => {
        const textarea = new FakeElement('textarea');
        textarea.dataset.mode = mode;
        document.register('#filteringSiteRules textarea[data-mode]', textarea);
        return [ mode, textarea ];
    }));
    const saveSiteRules = document.register('#saveFilteringSiteRules', new FakeElement('button'));
    document.register('#runtimeCapabilities', new FakeElement('dl'));
    const performance = document.register('#performanceDetails', new FakeElement('dl'));
    document.register('#popupDiagnosticRows', new FakeElement('tbody'));
    document.register('#popupDiagnosticsEmpty');
    document.register('#refreshDiagnostics', new FakeElement('button'));
    const diagnosticsPane = document.register('section[data-pane="diagnostics"]', new FakeElement('section'));
    for ( const pane of [ 'settings', 'siteRules', 'diagnostics' ] ) {
        const button = new FakeElement('button');
        button.dataset.pane = pane;
        button.ancestors.set('.tabButton', button);
        document.register('.tabButton[data-pane]', button);
    }

    const state = {
        defaultFilteringMode: 2, autoReload: true, showBlockedCount: true,
        strictBlockMode: true, popupBlockMode: true, hasOmnipotence: false,
        memory: 'auto',
    };
    let modes = { none: [ 'trusted.example' ], basic: [], optimal: [ 'all-urls' ], complete: [] };
    let failWhat;
    let commitThenFail = false;
    const extension = createExtension({
        storage: {
            'powerUI.settings': {
                schemaVersion: 1, theme: 'auto', accent: 'crimson',
                density: 'comfortable', popupLayout: 'power',
            },
        },
        dispatch(request) {
            if ( request.what === failWhat ) { throw new Error(`${failWhat} failed`); }
            switch ( request.what ) {
            case 'getOptionsPageData': {
                const { memory, ...options } = state;
                return { ...options, memory };
            }
            case 'getMemoryProfile':
                return { selected: state.memory, effective: state.memory, deviceMemoryGiB: 8 };
            case 'setDefaultFilteringMode':
                state.defaultFilteringMode = request.level;
                return request.level;
            case 'setAutoReload':
            case 'setShowBlockedCount':
            case 'setStrictBlockMode':
            case 'setPopupBlockMode': {
                const key = request.what.charAt(3).toLowerCase() + request.what.slice(4);
                state[key] = request.state;
                return;
            }
            case 'setMemoryProfile':
                state.memory = request.profile;
                return { selected: state.memory };
            case 'getPopupPolicies':
                return { policies: {} };
            case 'getFilteringModeDetails':
                return structuredClone(modes);
            case 'setFilteringModeDetails':
                modes = structuredClone(request.modes);
                // Like a script-registration failure after the mode commit.
                if ( commitThenFail ) { throw new Error('Script registration failed'); }
                return structuredClone(modes);
            case 'getRuntimeCapabilities':
                return { productEdition: 'standard', quotas: {} };
            case 'getPopupDiagnostics':
                return [];
            }
        },
    });
    const { error: consoleError } = console;
    console.error = ( ) => {};
    const staged = await stageModules({
        modules: [
            'power-settings.js', 'power-ui.js', 'power-ui-core.js', 'dashboard.js',
            'backup-schema.js', 'popup-policy.js', 'firewall-core.js',
            'firewall-index.js', 'runtime-capabilities-ui.js',
        ],
        document,
        extension,
    });
    const writes = ( ) => extension.messages.filter(request =>
        /^set(?:DefaultFilteringMode|AutoReload|ShowBlockedCount|StrictBlockMode|PopupBlockMode|MemoryProfile)$/
            .test(request.what)
    );
    const selectPane = async pane => {
        const button = document.all('.tabButton[data-pane]')
            .find(node => node.dataset.pane === pane);
        await document.trigger('#dashboard-nav', 'click', { target: button }, '.tabButton');
        await settle(20);
    };
    try {
        // As in dashboard.html, the pane navigation module runs first.
        await staged.load('dashboard.js');
        await staged.load('power-settings.js');
        await settle(20);
        assert.equal(profileLabel.textContent,
            '[protectionProfileActive:[protectionProfileBalanced]]');
        assert.equal(checkedProfile(), 'balanced');

        // The Settings pane and the popup change the same values: the profile
        // label must follow them.
        state.autoReload = false;
        extension.broadcast({ autoReload: false });
        await settle(80);
        assert.equal(profileLabel.textContent, '[protectionProfileCustomActive]',
            'The active profile label must follow live settings');
        assert.equal(checkedProfile(), undefined,
            'An untouched selection follows live settings');
        state.memory = 'low-memory';
        extension.emitStorageChange({ memoryProfile: { newValue: 'low-memory' } });
        await settle(80);

        // Apply without a chosen profile says so instead of doing nothing.
        extension.messages.length = 0;
        await document.trigger('#applyProtectionProfile', 'click');
        await settle(20);
        assert.deepEqual(writes(), []);
        assert.equal(status.textContent, '[protectionProfileSelectRequired]');
        assert.equal(status.dataset.level, 'error');

        // Declining the permission prompt happens before any write, so it
        // must not restore anything, least of all a page-load snapshot.
        pick('maximum');
        extension.browser.permissions.request = async ( ) => false;
        extension.messages.length = 0;
        await document.trigger('#applyProtectionProfile', 'click');
        await settle(20);
        assert.deepEqual(writes(), [], 'A declined permission prompt writes nothing');
        assert.equal(state.autoReload, false);
        assert.equal(state.memory, 'low-memory');
        assert.equal(status.textContent, '[protectionProfilePermissionDenied]');
        assert.equal(applyButton.disabled, false);

        // A failed apply rolls back to the live settings.
        pick('maximum');
        extension.browser.permissions.request = async ( ) => true;
        failWhat = 'setPopupBlockMode';
        await document.trigger('#applyProtectionProfile', 'click');
        await settle(20);
        failWhat = undefined;
        assert.equal(state.defaultFilteringMode, 2);
        assert.equal(state.autoReload, false, 'Rollback must use live settings');
        assert.equal(state.memory, 'low-memory');
        assert.equal(status.dataset.level, 'error');

        // Toggling a setting in the Settings pane, or a site mode in the
        // popup, broadcasts before the user clicks Apply: the refresh updates
        // the label but keeps the profile the user chose.
        pick('maximum');
        extension.broadcast({ autoReload: false });
        await settle(80);
        assert.equal(checkedProfile(), 'maximum',
            'A refresh must not clear a pending profile choice');
        assert.equal(profileLabel.textContent, '[protectionProfileCustomActive]');
        state.autoReload = true;
        state.memory = 'auto';
        extension.broadcast({ autoReload: true, hasOmnipotence: true });
        extension.emitStorageChange({ memoryProfile: { newValue: 'auto' } });
        await settle(80);
        assert.equal(profileLabel.textContent,
            '[protectionProfileActive:[protectionProfileBalanced]]');
        assert.equal(checkedProfile(), 'maximum',
            'A refresh must not replace a pending profile choice');

        await document.trigger('#applyProtectionProfile', 'click');
        await settle(80);
        assert.equal(state.defaultFilteringMode, 3, 'Apply applies the chosen profile');
        assert.equal(state.memory, 'balanced');
        assert.equal(profileLabel.textContent,
            '[protectionProfileActive:[protectionProfileMaximum]]');
        assert.equal(checkedProfile(), 'maximum');
        // Once applied, the radios follow live settings again.
        state.strictBlockMode = false;
        extension.broadcast({ strictBlockMode: false });
        await settle(80);
        assert.equal(checkedProfile(), undefined);
        state.strictBlockMode = true;
        extension.broadcast({ strictBlockMode: true });
        await settle(80);
        assert.equal(checkedProfile(), 'maximum');

        // The popup layout toggle writes the same storage entry: another
        // appearance change must not revert it.
        assert.equal(appearance.get('popupLayout').value, 'power');
        extension.storage.set('powerUI.settings', {
            ...extension.storage.get('powerUI.settings'), popupLayout: 'compact',
        });
        await settle(20);
        assert.equal(appearance.get('popupLayout').value, 'compact');
        appearance.get('popupLayout').value = 'power';
        appearance.get('theme').value = 'dark';
        await document.trigger('#appearanceSettings', 'change',
            { target: appearance.get('theme') }, '[data-power-ui]');
        await settle(20);
        assert.deepEqual(extension.storage.get('powerUI.settings'), {
            schemaVersion: 1, theme: 'dark', accent: 'crimson',
            density: 'comfortable', popupLayout: 'compact',
        }, 'Only the changed appearance preference may be written');

        // Site Rules accept exactly what the Advanced editor and backups do.
        await selectPane('siteRules');
        assert.equal(textareas.get('none').value, 'trusted.example');
        assert.equal(textareas.get('optimal').value, 'all-urls');
        const trySave = async texts => {
            for ( const [ mode, textarea ] of textareas ) {
                textarea.value = texts[mode] ?? '';
            }
            extension.messages.length = 0;
            await document.trigger('#saveFilteringSiteRules', 'click', { target: saveSiteRules });
            await settle(20);
            return extension.messages.some(request => request.what === 'setFilteringModeDetails');
        };
        for ( const [ texts, expected ] of [
            [ { none: 'trusted.example' }, '[siteRulesDefaultRequired:all-urls]' ],
            [ { optimal: 'all-urls', complete: '*.news.example' }, '[siteRulesInvalidHostname:*.news.example]' ],
            [ { optimal: 'all-urls', complete: 'https://shop.example/' }, '[siteRulesInvalidHostname:https://shop.example/]' ],
            [ { none: 'a.example', optimal: 'all-urls\na.example' }, '[siteRulesDuplicateHostname:a.example]' ],
            [ { optimal: 'all-urls', complete: 'all-urls' }, '[siteRulesDuplicateHostname:all-urls]' ],
        ] ) {
            assert.equal(await trySave(texts), false, `Rejected before saving: ${expected}`);
            assert.equal(status.textContent, expected);
            assert.equal(saveSiteRules.disabled, false);
        }
        assert.deepEqual(modes.optimal, [ 'all-urls' ], 'Rejected drafts change nothing');
        const validTexts = {
            none: 'trusted.example\nmy_app.intranet.example\nexample.com.',
            optimal: '# default\nall-urls',
            complete: 'BÜCHER.example\nNews.example\nnews.example',
        };
        // A background failure is not reported as invalid input.
        failWhat = 'setFilteringModeDetails';
        assert.equal(await trySave(validTexts), true);
        failWhat = undefined;
        assert.equal(status.textContent, '[siteRulesSaveFailed:setFilteringModeDetails failed]');
        assert.deepEqual(modes.none, [ 'trusted.example' ]);
        commitThenFail = true;
        assert.equal(await trySave(validTexts), true);
        commitThenFail = false;
        assert.equal(status.textContent, '[siteRulesSaveFailed:Script registration failed]');
        // Saving again finds the draft already stored: not a conflict.
        assert.equal(await trySave(validTexts), false);
        assert.deepEqual(modes, {
            none: [ 'trusted.example', 'my_app.intranet.example', 'example.com.' ],
            basic: [], optimal: [ 'all-urls' ],
            complete: [ 'xn--bcher-kva.example', 'news.example' ],
        });
        assert.equal(status.textContent, '[siteRulesSaved]');

        // A committed change from the popup refreshes an unedited view...
        modes.none.push('popup.example');
        extension.broadcast({ filteringModeDetails: structuredClone(modes) });
        assert.match(textareas.get('none').value, /popup\.example/);
        // ...but never replaces a draft, and a Save made from a stale draft
        // is refused once so that it cannot silently undo that change.
        textareas.get('basic').value = 'draft.example';
        modes.none.push('later.example');
        extension.broadcast({ filteringModeDetails: structuredClone(modes) });
        assert.equal(textareas.get('basic').value, 'draft.example');
        assert.doesNotMatch(textareas.get('none').value, /later\.example/);
        extension.messages.length = 0;
        await document.trigger('#saveFilteringSiteRules', 'click', { target: saveSiteRules });
        await settle(20);
        assert.equal(extension.messages.some(request => request.what === 'setFilteringModeDetails'), false);
        assert.equal(status.textContent, '[siteRulesChangedElsewhere]');
        assert.equal(textareas.get('basic').value, 'draft.example', 'The draft is kept');
        await document.trigger('#saveFilteringSiteRules', 'click', { target: saveSiteRules });
        await settle(20);
        assert.deepEqual(modes.basic, [ 'draft.example' ], 'A second Save overwrites deliberately');
        // Revisiting the pane reloads rules changed without a broadcast.
        modes.complete.push('restored.example');
        await selectPane('settings');
        await selectPane('siteRules');
        assert.match(textareas.get('complete').value, /restored\.example/);

        // Diagnostics are localized, including memory-profile names.
        await selectPane('diagnostics');
        const setupPanel = diagnosticsPane.children.find(node => node.id === 'webRequestSetup');
        assert.deepEqual(setupPanel.children.map(node => node.textContent), [
            '[webRequestSetupTitle]', '[webRequestSetupStandard]',
            '[webRequestSetupLimits]', '[webRequestSetupGuide]',
        ]);
        const performanceText = performance.children.map(node => node.textContent);
        assert.equal(performanceText[1], '[memoryProfileBalanced]');
        assert.equal(performanceText[3], '[memoryProfileBalanced]');
    } finally {
        console.error = consoleError;
        (await staged.load('dashboard.js')).setOperationStatus('');
        await staged.cleanup();
    }
}

console.log('Power UI schema tests passed');
