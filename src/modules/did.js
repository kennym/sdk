import {encodeAddress, decodeAddress} from '@polkadot/util-crypto';
import {u8aToHex} from '@polkadot/util';

import {isHexWithGivenByteSize, getBytesForStateChange} from '../utils';

const DockDIDQualifier = 'did:dock:';
const DockDIDByteSize = 32;

const signatureHeaders = {
  Sr25519VerificationKey2018: 'Sr25519SignatureAuthentication2018',
  Ed25519VerificationKey2018: 'Ed25519SignatureAuthentication2018',
  EcdsaSecp256k1VerificationKey2019: 'EcdsaSecp256k1SignatureAuthentication2019',
};

/**
 * Check if the given identifier is 32 byte hex
 * @param {identifier} identifier - The identifier to check.
 * @return {null} Throws exception if invalid identifier
 */
function validateDockDIDIdentifier(identifier) {
  // Byte size of the Dock DID identifier, i.e. the `DockDIDQualifier` is not counted.
  if (!isHexWithGivenByteSize(identifier, DockDIDByteSize)) {
    throw new Error(`DID identifier must be ${DockDIDByteSize} bytes`);
  }
}

/**
 * Gets the hexadecimal value of the given DID.
 * @param {string} did -  The DID can be passed as fully qualified DID like `dock:did:<SS58 string>` or
 * a 32 byte hex string
 * @return {string} Returns the hexadecimal representation of the DID.
 */
function getHexIdentifierFromDID(did) {
  if (did.startsWith(DockDIDQualifier)) {
    // Fully qualified DID. Remove the qualifier
    let ss58Did = did.slice(DockDIDQualifier.length);
    try {
      const hex = u8aToHex(decodeAddress(ss58Did));
      // 2 characters for `0x` and 2*byte size of DID
      if (hex.length !== (2 + 2*DockDIDByteSize)) {
        throw new Error('Unexpected byte size');
      }
      return hex;
    } catch (e) {
      throw new Error(`Invalid SS58 DID ${did}. ${e}`);
    }
  } else {
    try {
      // Check if hex and of correct size and return the hex value if successful.
      validateDockDIDIdentifier(did);
      return did;
    } catch (e) {
      // Cannot parse as hex
      throw new Error(`Invalid hexadecimal DID ${did}. ${e}`);
    }
  }
}

/** Class to create, update and destroy DIDs */
class DIDModule {
  /**
   * Creates a new instance of DIDModule and sets the api
   * @constructor
   * @param {object} api - PolkadotJS API Reference
   */
  constructor(api) {
    this.api = api;
    this.module = api.tx.didModule;
  }

  /**
   * Creates a new DID on the Dock chain.
   * @param {string} did - The new DID
   * @param {string} controller - The DID of the public key's controller
   * @param {PublicKey} publicKey - A public key associated with the DID
   * @return {Extrinsic} The extrinsic to sign and send.
   */
  new(did, controller, publicKey) {
    // Controller and did should be valid Dock DIDs
    validateDockDIDIdentifier(did);
    validateDockDIDIdentifier(controller);
    return this.module.new(did, {
      controller,
      public_key: publicKey.toJSON(),
    });
  }

  /**
   * Updates the details of an already registered DID on the Dock chain.
   * @param {string} did - DID
   * @param {Signature} signature - Signature from existing key
   * @param {PublicKey} publicKey -The new public key
   * @param {string} controller - Optional, The new key's controller
   * @return {Extrinsic} The extrinsic to sign and send.
   */
  updateKey(did, signature, publicKey, last_modified_in_block, controller) {
    validateDockDIDIdentifier(did);
    if (controller) {
      validateDockDIDIdentifier(controller);
    }
    const keyUpdate = {
      did,
      controller,
      public_key: publicKey.toJSON(),
      last_modified_in_block,
    };

    return this.module.updateKey(keyUpdate, signature.toJSON());
  }

  /**
   * Removes an already registered DID on the Dock chain.
   * @param {string} did - DID
   * @param {Signature} signature - Signature from existing key
   * @return {Extrinsic} The extrinsic to sign and send.
   */
  remove(did, signature, last_modified_in_block) {
    validateDockDIDIdentifier(did);
    return this.module.remove({
      did,
      last_modified_in_block,
    }, signature.toJSON());
  }

  /**
   * Create the fully qualified DID like "did:dock:..."
   * @param {string} did - DID
   * @return {string} The DID identifer.
   */
  getFullyQualifiedDID(did) {
    return `${DockDIDQualifier}${did}`;
  }

  /**
   * Gets a DID from the Dock chain and create a DID document according to W3C spec.
   * @param {string} did - The DID can be passed as fully qualified DID like `dock:did:<SS58 string>` or
   * a 32 byte hex string
   * @return {object} The DID document.
   */
  async getDocument(did) {
    let hexDid = getHexIdentifierFromDID(did);
    const detail = (await this.getDetail(hexDid))[0];
    // If given DID was in hex, encode to SS58 and then construct fully qualified DID else the DID was already fully qualified
    const id = (did === hexDid) ? this.getFullyQualifiedDID(encodeAddress(hexDid)) : did;

    // Determine the type of the public key
    let type, publicKeyBase58;
    if (detail.public_key.isSr25519) {
      type = 'Sr25519VerificationKey2018';
      publicKeyBase58 = detail.public_key.asSr25519;
    } else if (detail.public_key.isEd25519) {
      type = 'Ed25519VerificationKey2018';
      publicKeyBase58 = detail.public_key.asEd25519;
    } else {
      type = 'EcdsaSecp256k1VerificationKey2019';
      publicKeyBase58 = detail.public_key.asSecp256K1;
    }

    // The DID has only one key as of now.
    const publicKey = {
      id: `${id}#keys-1`,
      type,
      controller: `${DockDIDQualifier}${detail.controller}`,
      publicKeyBase58,
      // publicKeyPem: '-----BEGIN PUBLIC KEY...END PUBLIC KEY-----\r\n', // TODO: add proper value
    };

    // Set keys and authentication reference
    const publicKeys = [publicKey];
    const authentication = publicKeys.map(key => {
      return {
        type: signatureHeaders[key.type],
        publicKey: [key.id]
      };
    });

    // TODO: setup proper service when we have it
    // const service = [{
    //   id: `${id}#vcs`,
    //   type: 'VerifiableCredentialService',
    //   serviceEndpoint: 'https://dock.io/vc/'
    // }];

    return {
      '@context': 'https://www.w3.org/ns/did/v1',
      id,
      authentication,
      publicKey: publicKeys
      // service,
    };
  }

  /**
   * Gets the key detail and block number in which the DID was last modified from
   * the chain and return them. It will throw error if the DID does not exist on
   * chain or chain returns null response.
   * @param {string} did - DID
   * @return {array} A 2 element array with first
   */
  async getDetail(did) {
    const resp = await this.api.query.didModule.dids(did);
    if (resp) {
      if (resp.isNone) {
        throw new Error('Could not find DID: ' + did);
      }

      const respTuple = resp.unwrap();
      if (respTuple.length === 2) {
        return [
          respTuple[0],
          respTuple[1].toNumber()
        ];
      } else {
        throw new Error('Needed 2 items in response but got' + respTuple.length);
      }
    }
  }

  /**
   * Prepare a `KeyUpdate` for signing. It takes the fields of a `KeyUpdate`, wraps it in the `StateChange` enum and
   * serializes it to bytes.
   * @param {string} did - DID
   * @param {PublicKey} publicKey - The new public key
   * @param {number} last_modified_in_block - The block number when the DID was last modified.
   * @param {string} controller - Controller DID
   * @return {array} An array of Uint8
   */
  getSerializedKeyUpdate(did, publicKey, last_modified_in_block, controller) {
    const keyUpdate = {
      did,
      public_key: publicKey.toJSON(),
      controller,
      last_modified_in_block
    };
    const stateChange = {
      KeyUpdate: keyUpdate
    };

    return getBytesForStateChange(this.api, stateChange);
  }

  /**
   * Prepare a `DidRemoval` for signing. It takes the fields of a `DidRemoval`, wraps it in the `StateChange` enum and
   * serializes it to bytes.
   * @param {string} did - DID
   * @param {number} last_modified_in_block - The block number when the DID was last modified.
   * @return {array} An array of Uint8
   */
  getSerializedDIDRemoval(did, last_modified_in_block) {
    const remove = {
      did,
      last_modified_in_block
    };
    const stateChange = {
      DidRemoval: remove
    };

    return getBytesForStateChange(this.api, stateChange);
  }
}

export default DIDModule;

// Exporting private functions to test.
// Consider: Should a package like rewire be used instead?
export const privates = {
  validateDockDIDIdentifier: validateDockDIDIdentifier,
  getHexIdentifierFromDID: getHexIdentifierFromDID,
  DockDIDQualifier: DockDIDQualifier
};
