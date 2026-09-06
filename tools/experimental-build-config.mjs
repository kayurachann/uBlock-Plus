// uBlock Plus+ — GPL-3.0-or-later. See LICENSE.txt.

import { createHash, createPublicKey } from 'node:crypto';
import { Buffer } from 'node:buffer';

export const experimentalName = 'uBlock Plus+ Experimental';
export const experimentalExtensionId = 'fokcgioblkdjdajdeifgfjgmnejmgggg';

export function experimentalIdentityErrors(metadata) {
    const errors = [];
    if ( metadata?.schemaVersion !== 1 ||
        metadata?.edition !== 'experimental-webrequest' ) {
        errors.push('Experimental metadata must declare schemaVersion 1 and experimental-webrequest edition');
    }
    if ( metadata?.extensionId !== experimentalExtensionId ) {
        errors.push('Experimental metadata has an unexpected extension ID');
    }
    try {
        if ( typeof metadata?.publicKey !== 'string' ) { throw new Error(); }
        const key = Buffer.from(metadata.publicKey, 'base64');
        const publicKey = createPublicKey({ key, format: 'der', type: 'spki' });
        if ( key.toString('base64') !== metadata.publicKey ||
            publicKey.asymmetricKeyType !== 'rsa' ||
            publicKey.asymmetricKeyDetails.modulusLength < 2048 ||
            publicKey.export({ format: 'der', type: 'spki' }).equals(key) === false ) {
            throw new Error();
        }
        const id = createHash('sha256').update(key).digest('hex').slice(0, 32)
            .replace(/[0-9a-f]/g, character =>
                String.fromCharCode(97 + Number.parseInt(character, 16)));
        if ( id !== metadata.extensionId ) {
            errors.push('Experimental public key does not match its extension ID');
        }
    } catch {
        errors.push('Experimental metadata must contain a canonical RSA public key');
    }
    return errors;
}

export function experimentalManifestErrors(manifest, metadata, enabled) {
    const permissions = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
    const optional = Array.isArray(manifest?.optional_permissions) ? manifest.optional_permissions : [];
    if ( enabled !== true ) {
        return permissions.includes('webRequestBlocking') ||
            optional.includes('webRequestBlocking') || metadata !== undefined
            ? [ 'Experimental webRequest builds require --experimental-webrequest validation' ]
            : [];
    }
    const errors = experimentalIdentityErrors(metadata);
    if ( manifest?.manifest_version !== 3 ||
        manifest?.name !== experimentalName ||
        manifest?.key !== metadata?.publicKey ) {
        errors.push('Experimental manifest identity does not match its metadata');
    }
    for ( const permission of [ 'webRequest', 'webRequestBlocking', 'declarativeNetRequest' ] ) {
        if ( permissions.includes(permission) === false || optional.includes(permission) ) {
            errors.push(`Experimental manifest must require ${permission}, without an optional duplicate`);
        }
    }
    return errors;
}
