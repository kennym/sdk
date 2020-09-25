import vc from 'vc-js';
import {
  expandedLogicProperty,
  acceptCompositeClaims,
  proveh,
  validateh,
  presentationToEEClaimGraph,
  proveCompositeClaims,
} from '../../src/utils/cd';
import { claims } from '../../src/utils/claimgraph';
import { Ed25519KeyPair, suites } from 'jsonld-signatures';
import jsonld from 'jsonld';
import axios from 'axios';
import contexts from '../../src/utils/vc/contexts';
import {
  EcdsaSepc256k1Signature2019, Ed25519Signature2018, Sr25519Signature2020,
} from '../../src/utils/vc/custom_crypto';
import { randomAsHex } from '@polkadot/util-crypto';
import network_cache from '../network-cache';
import check from '@polkadot/util-crypto/address/check';

/// global document cache, acts as a did method for the tests below
let documentRegistry = {};
for (let [k, v] of contexts) {
  documentRegistry[k] = v;
}
for (let k of Object.keys(network_cache)) {
  documentRegistry[k] = network_cache[k];
}

describe('Composite claim soundness checker', () => {
  test('control: issue and verify', async () => {
    let { did: issuer, suite: kp } = await newDid();

    let cred = {
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://www.w3.org/2018/credentials/examples/v1"
      ],
      "id": "https://example.com/credentials/1872",
      "type": ["VerifiableCredential"],
      "issuer": issuer,
      "issuanceDate": "2010-01-01T19:23:24Z",
      "credentialSubject": {
        "id": "did:example:ebfeb1f712ebc6f1c276e12ec21",
        "alumniOf": "Example University"
      }
    };
    let credential = await vc.issue({
      credential: cred,
      suite: kp,
      documentLoader,
    });
    expect(await verifyC(credential))
      .toHaveProperty('verified', true);
    credential.issuanceDate = "9010-01-01T19:23:24Z";
    expect(await verifyC(credential))
      .toHaveProperty('verified', false);
  });

  test('assumption: credential with false issuer will fail', async () => {
    let { did: issuera, suite: kpa } = await newDid();
    let { did: issuerb, suite: kpb } = await newDid();

    // fyi signing a cred does modify the cred by adding a proof
    let cred = () => {
      return {
        "@context": [
          "https://www.w3.org/2018/credentials/v1",
          "https://www.w3.org/2018/credentials/examples/v1"
        ],
        "id": "https://example.com/credentials/1872",
        "type": ["VerifiableCredential"],
        "issuer": issuera,
        "issuanceDate": "2010-01-01T19:23:24Z",
        "credentialSubject": {
          "id": "did:example:ebfeb1f712ebc6f1c276e12ec21",
          "alumniOf": "Example University"
        }
      }
    };

    expect(await verifyC(
      await vc.issue({
        credential: cred(),
        suite: kpa,
        documentLoader,
      })
    )).toHaveProperty('verified', true);

    let err;
    err = await verifyC(
      await vc.issue({
        credential: cred(),
        suite: kpb, // signing a key not accociated with issuera
        documentLoader,
      })
    );
    expect(err).toHaveProperty('verified', false);
    expect(err.results[0].error.toString())
      .toMatch("Error: Credential issuer must match the verification method controller.");

    // modify the attackers keydoc to point assert it's controller is issuera
    documentRegistry[`${issuerb}#keys-1`].controller = issuera;
    err = await verifyC(
      await vc.issue({
        credential: cred(),
        suite: kpb, // signing a key not accociated with issuera
        documentLoader,
      })
    );
    expect(err).toHaveProperty('verified', false);
    expect(err.results[0].error.toString()).toMatch(/not authorized by controller/);
  });

  test('behavior on empty input', () => {
    let premises = [];
    let to_prove = [];
    let rules = [];
    let proof = proveh(premises, to_prove, rules);
    let valid = validateh(rules, proof);
    expect(valid).toEqual({ assumed: [], implied: [] });
  });

  // The user is able to input a set of credentials, along with an associated proof of composite
  // claim[s].
  //
  // The proof validator(DCK-70) correctly validates the proof.
  //
  // The verification result is provided to the user.
  //
  // The program reports all composite claims which were proven.
  test('end to end, presentation to result', async () => {
    let rules = sampleRules();
    let presentation = await validPresentation();
    let issuer = presentation.verifiableCredential[0].issuer;
    // here we prove that [a frobs b], a pretty easy proof as the axiom used is unconditional
    presentation[expandedLogicProperty] = jsonLiteral([{
      rule_index: 0,
      instantiations: [],
    }]);
    let all = await checkSoundness(presentation, rules);
    expect(all).toEqual([
      [
        { Iri: issuer },
        { Iri: "https://www.dock.io/rdf2020#claimsV1" },
        { Blank: "_:b0" }
      ],
      [
        { Blank: "_:b0" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#subject" },
        { Iri: "did:example:ebfeb1f712ebc6f1c276e12ec21" }
      ],
      [
        { Blank: "_:b0" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate" },
        { Iri: "http://schema.org/alumniOf" }
      ],
      [
        { Blank: "_:b0" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#object" },
        {
          Literal: {
            value: "Example University",
            datatype: "http://www.w3.org/1999/02/22-rdf-syntax-ns#HTML"
          }
        }
      ],
      [
        { Iri: issuer },
        { Iri: "https://www.dock.io/rdf2020#claimsV1" },
        { Blank: "_:b1" }
      ],
      [
        { Blank: "_:b1" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#subject" },
        { Iri: "https://example.com/credentials/1872" }
      ],
      [
        { Blank: "_:b1" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" }
      ],
      [
        { Blank: "_:b1" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#object" },
        { Iri: "https://www.w3.org/2018/credentials#VerifiableCredential" }
      ],
      [
        { Iri: issuer },
        { Iri: "https://www.dock.io/rdf2020#claimsV1" },
        { Blank: "_:b2" }
      ],
      [
        { Blank: "_:b2" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#subject" },
        { Iri: "https://example.com/credentials/1872" }
      ],
      [
        { Blank: "_:b2" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate" },
        { Iri: "https://www.w3.org/2018/credentials#credentialSubject" }
      ],
      [
        { Blank: "_:b2" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#object" },
        { Iri: "did:example:ebfeb1f712ebc6f1c276e12ec21" }
      ],
      [
        { Iri: issuer },
        { Iri: "https://www.dock.io/rdf2020#claimsV1" },
        { Blank: "_:b3" }
      ],
      [
        { Blank: "_:b3" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#subject" },
        { Iri: "https://example.com/credentials/1872" }
      ],
      [
        { Blank: "_:b3" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate" },
        { Iri: "https://www.w3.org/2018/credentials#issuanceDate" }
      ],
      [
        { Blank: "_:b3" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#object" },
        {
          Literal: {
            value: "2010-01-01T19:23:24Z",
            datatype: "http://www.w3.org/2001/XMLSchema#dateTime"
          }
        }
      ],
      [
        { Iri: issuer },
        { Iri: "https://www.dock.io/rdf2020#claimsV1" },
        { Blank: "_:b4" }
      ],
      [
        { Blank: "_:b4" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#subject" },
        { Iri: "https://example.com/credentials/1872" }
      ],
      [
        { Blank: "_:b4" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate" },
        { Iri: "https://www.w3.org/2018/credentials#issuer" }
      ],
      [
        { Blank: "_:b4" },
        { Iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#object" },
        { Iri: issuer }
      ],
      [
        { Iri: "https://example.com/a" },
        { Iri: "https://example.com/frobs" },
        { Iri: "https://example.com/b" }
      ]
    ]);
  });

  // Soundness checking fails if and only if one of the following conditions occurs:
  // - Proof assumes claims not attested to by the provided credentials and is therefore not verifiable.
  // - Credential claims are not verifiable(credential verification fails) so proof is not verifiable.

  test('Proof including unstated claims should fail.', async () => {
    let rules = sampleRules();
    let presentation = await validPresentation();
    presentation[expandedLogicProperty] = jsonLiteral([{
      rule_index: 1,
      instantiations: [{ Iri: "http://example.com/joeThePig" }],
    }]);
    expect(checkSoundness(presentation, rules))
      .rejects
      .toHaveProperty('unverifiedAssumption', [
        { Iri: "http://example.com/joeThePig" },
        { Iri: "https://example.com/Ability" },
        { Iri: "https://example.com/Flight" },
      ]);
  });

  test('Proof including inapplicable rule should fail.', async () => {
    let rules = sampleRules();
    let presentation = await validPresentation();
    presentation[expandedLogicProperty] = jsonLiteral([{
      rule_index: 0,
      instantiations: [{ Iri: "http://example.com" }],
    }]);
    expect(checkSoundness(presentation, rules))
      .rejects
      .toEqual({ InvalidProof: "BadRuleApplication" });
  });

  test('Unverifiable credential should fail.', async () => {
    let rules = sampleRules();
    let presentation = await validPresentation();
    presentation.verifiableCredential[0].issuer = "did:dock:bobert"; // tamper
    presentation[expandedLogicProperty] = jsonLiteral([{ rule_index: 0, instantiations: [] }]);
    expect(
      checkSoundness(presentation, rules)
        .catch((err) => Promise.reject(JSON.stringify(err)))
    )
      .rejects
      .toMatch(/Invalid signature/);
  });

  test('bddap is named Gorgadon because joe is a pig that can fly', async () => {
    let { did: pigchecker, suite: pigchecker_kp } = await newDid();
    let { did: faa, suite: faa_kp } = await newDid();

    // if pigs can fly, then bddap is Gorgadon
    let gorg = {
      if_all: [
        [
          { Unbound: "pig" },
          { Bound: { Iri: "https://example.com/Ability" } },
          { Bound: { Iri: "https://example.com/Flight" } }
        ],
        [
          { Unbound: "pig" },
          { Bound: rdf('type') },
          { Bound: { Iri: "https://example.com/Pig" } }
        ],
      ],
      then: [
        [
          { Bound: { Iri: "did:dock:bddap" } },
          { Bound: { Iri: "http://xmlns.com/foaf/spec/#term_firstName" } },
          {
            Bound: {
              Literal: {
                value: "Gorgadon",
                datatype: "http://www.w3.org/1999/02/22-rdf-syntax-ns#PlainLiteral",
              }
            }
          }
        ]
      ]
    };
    let licensing = {
      // if licenser? claims [a? lp? lo?]
      // and licenser? mayLicence li?
      // and li? predicate lp?
      // and li? object lo?
      if_all: [
        [
          { Unbound: "licenser" },
          { Bound: claims },
          { Unbound: "c0" }
        ],
        [
          { Unbound: "c0" },
          { Bound: rdf('subject') },
          { Unbound: "a" }
        ],
        [
          { Unbound: "c0" },
          { Bound: rdf('predicate') },
          { Unbound: "lp" }
        ],
        [
          { Unbound: "c0" },
          { Bound: rdf('object') },
          { Unbound: "lo" }
        ],
        [
          { Unbound: "licenser" },
          { Bound: { Iri: "https://example.com/mayLicense" } },
          { Unbound: "li" }
        ],
        [
          { Unbound: "li" },
          { Bound: rdf('predicate') },
          { Unbound: "lp" }
        ],
        [
          { Unbound: "li" },
          { Bound: rdf('object') },
          { Unbound: "lo" }
        ],
      ],
      // then [a? lp? lo?],
      then: [
        [
          { Unbound: "a" },
          { Unbound: "lp" },
          { Unbound: "lo" }
        ]
      ]
    };
    let licenses = {
      if_all: [],
      then: [
        // the Federal Aviation Administration may grant the ability to fly
        [
          { Bound: { Iri: faa } },
          { Bound: { Iri: "https://example.com/mayLicense" } },
          { Bound: { Iri: "uuid:5c4cfa6b-d96f-4a53-8786-2cce46cc51c4" } },
        ],
        [
          { Bound: { Iri: "uuid:5c4cfa6b-d96f-4a53-8786-2cce46cc51c4" } },
          { Bound: rdf('predicate') },
          { Bound: { Iri: "https://example.com/Ability" } },
        ],
        [
          { Bound: { Iri: "uuid:5c4cfa6b-d96f-4a53-8786-2cce46cc51c4" } },
          { Bound: rdf('object') },
          { Bound: { Iri: "https://example.com/Flight" } },
        ],
        // pigchecker is trusted to check whether something is a pig
        [
          { Bound: { Iri: pigchecker } },
          { Bound: { Iri: "https://example.com/mayLicense" } },
          { Bound: { Iri: "uuid:6f165460-894a-4e51-a2a5-79b537678720" } },
        ],
        [
          { Bound: { Iri: "uuid:6f165460-894a-4e51-a2a5-79b537678720" } },
          { Bound: rdf('predicate') },
          { Bound: rdf('type') },
        ],
        [
          { Bound: { Iri: "uuid:6f165460-894a-4e51-a2a5-79b537678720" } },
          { Bound: rdf('object') },
          { Bound: { Iri: "https://example.com/Pig" } },
        ]
      ]
    };
    let rules = [gorg, licensing, licenses];

    let joe_is_a_pig = await vc.issue({
      credential: {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        "id": "https://example.com/credentials/1872",
        "type": ["VerifiableCredential"],
        "issuer": pigchecker,
        "issuanceDate": "2010-01-01T19:23:24Z",
        "credentialSubject": {
          "@id": "did:example:joe",
          "@type": "https://example.com/Pig",
        }
      },
      suite: pigchecker_kp,
      documentLoader,
    });
    let joe_can_fly = await vc.issue({
      credential: {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        "id": "https://example.com/credentials/1872",
        "type": ["VerifiableCredential"],
        "issuer": faa,
        "issuanceDate": "2010-01-01T19:23:24Z",
        "credentialSubject": {
          "@id": "did:example:joe",
          "https://example.com/Ability": { "@id": "https://example.com/Flight" }
        }
      },
      suite: faa_kp,
      documentLoader,
    });

    let presentation = await vc.createPresentation({
      verifiableCredential: [
        joe_can_fly,
        joe_is_a_pig,
      ],
      id: 'uuid:ce0d9145-934a-42b3-aa48-af1d27f33c2a',
      holder: 'uuid:078644cf-de19-436c-9691-fbe8a569a1d4'
    });

    // create a proof that bddap is Gorgadon
    let presentation_claimgraph = await presentationToEEClaimGraph(
      (await jsonld.expand(presentation, { documentLoader }))[0]
    );
    let claim_to_prove = [
      { Iri: "did:dock:bddap" },
      { Iri: "http://xmlns.com/foaf/spec/#term_firstName" },
      {
        Literal: {
          value: "Gorgadon",
          datatype: "http://www.w3.org/1999/02/22-rdf-syntax-ns#PlainLiteral",
        }
      }
    ];
    expect(presentation_claimgraph).not.toContainEqual(claim_to_prove);
    let proof = proveh(
      presentation_claimgraph,
      [claim_to_prove],
      rules
    );
    presentation[expandedLogicProperty] = jsonLiteral(proof);

    let cg = await checkSoundness(presentation, rules);
    expect(cg).toContainEqual(claim_to_prove);
  });

  test('holder: prove composite claim', async () => {
    const presentation = await validPresentation();
    const expandedPresentation = (await jsonld.expand(presentation, { documentLoader }))[0];
    const compositeClaim = [
      { Iri: "https://example.com/a" },
      { Iri: "https://example.com/frobs" },
      { Iri: "https://example.com/b" },
    ];
    const rules = sampleRules();
    let proof = await proveCompositeClaims(expandedPresentation, [compositeClaim], rules);
    expect(await checkSoundness(presentation, rules)).not.toContainEqual(compositeClaim);
    presentation[expandedLogicProperty] = proof;
    expect(await checkSoundness(presentation, rules)).toContainEqual(compositeClaim);
  });
});

// takes a verifiable presentation and rules, returns all claims which are known to be true under
// the given set of rules
// This function is intentionally not exposed publicly.
async function checkSoundness(presentation, rules) {
  let ver = await verifyP(presentation);
  if (!ver.verified) {
    throw ver.error;
  }
  // Pre-expand the presentaion using local cache. Tests run pretty slow otherwise.
  presentation = await jsonld.expand(presentation, { documentLoader });
  return await acceptCompositeClaims(presentation[0], rules);
}

/// create a fake document loader for did docs so we dont need to connect to a dev node
async function documentLoader(url) {
  if (documentRegistry[url] === undefined) {
    documentRegistry[url] = (await axios.get(url)).data;
    console.warn(
      'Unit test is making web requests. This is slow. Please update ./test/network-cache.json',
      'with: ',
      JSON.stringify({ [url]: documentRegistry[url] }, null, 2)
    );
  }
  return {
    documentUrl: url,
    document: documentRegistry[url],
  };
}

function registerDid(did, keyPair) {
  if (documentRegistry[did]) { throw `${did} already registered`; }
  let pk = {
    id: `${did}#keys-1`,
    type: keyPair.type,
    publicKeyBase58: keyPair.publicKeyBase58,
    controller: did,
  };
  let doc = {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: did,
    authentication: [pk.id],
    assertionMethod: [pk.id],
    publicKey: [pk],
  };
  documentRegistry[did] = doc;
  documentRegistry[pk.id] = {
    '@context': 'https://www.w3.org/ns/did/v1',
    ...pk
  };
}

function randoDID() {
  return `did:dock:${randomAsHex(32)}`;
}

async function verifyC(credential) {
  return await vc.verifyCredential({
    credential,
    suite: [
      new Ed25519Signature2018(),
      new EcdsaSepc256k1Signature2019(),
      new Sr25519Signature2020()
    ],
    documentLoader
  });
}

async function verifyP(presentation) {
  return await vc.verify({
    presentation,
    suite: [
      new Ed25519Signature2018(),
      new EcdsaSepc256k1Signature2019(),
      new Sr25519Signature2020()
    ],
    documentLoader,
    unsignedPresentation: true,
  });
}

async function newDid() {
  let did = randoDID();
  let keypair = await Ed25519KeyPair.generate();
  registerDid(did, keypair);
  keypair.id = `${did}#keys-1`;
  keypair.controller = did;
  return {
    did,
    suite: new suites.Ed25519Signature2018({
      verificationMethod: keypair.id,
      key: keypair,
    })
  };
}

async function validCredential() {
  let { did: issuer, suite: kp } = await newDid();
  let cred = {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://www.w3.org/2018/credentials/examples/v1"
    ],
    "id": "https://example.com/credentials/1872",
    "type": ["VerifiableCredential"],
    "issuer": issuer,
    "issuanceDate": "2010-01-01T19:23:24Z",
    "credentialSubject": {
      "id": "did:example:ebfeb1f712ebc6f1c276e12ec21",
      "alumniOf": "Example University"
    }
  };
  let credential = await vc.issue({
    credential: cred,
    suite: kp,
    documentLoader,
  });
  expect(await verifyC(credential))
    .toHaveProperty('verified', true);
  return credential;
}

/// makes an unsigned presentation
async function validPresentation() {
  let creds = [await validCredential()];
  let { did: holder } = await newDid();
  let presentation = vc.createPresentation({
    verifiableCredential: creds, id: `urn:${randomAsHex(16)}`, holder
  });
  expect(await verifyP(presentation))
    .toHaveProperty('verified', true);
  return presentation;
}

// https://w3c.github.io/json-ld-syntax/#json-literals
function jsonLiteral(json) {
  return {
    "@type": "@json",
    "@value": JSON.parse(JSON.stringify(json))
  };
}

function sampleRules() {
  return [
    {
      if_all: [],
      then: [
        [
          { Bound: { Iri: "https://example.com/a" } },
          { Bound: { Iri: "https://example.com/frobs" } },
          { Bound: { Iri: "https://example.com/b" } }
        ]
      ],
    },
    {
      if_all: [
        [
          { Unbound: "pig" },
          { Bound: { Iri: "https://example.com/Ability" } },
          { Bound: { Iri: "https://example.com/Flight" } }
        ],
        [
          { Unbound: "pig" },
          { Bound: { Iri: "https://www.w3.org/1999/02/22-rdf-syntax-ns#type" } },
          { Bound: { Iri: "https://example.com/Pig" } }
        ],
      ],
      then: [
        [
          { Bound: { Iri: "did:dock:bddap" } },
          { Bound: { Iri: "http://xmlns.com/foaf/spec/#term_firstName" } },
          {
            Bound: {
              Literal: {
                value: "Gorgadon",
                datatype: "http://www.w3.org/1999/02/22-rdf-syntax-ns#PlainLiteral",
              }
            }
          }
        ]
      ]
    }
  ];
}

// It's common to use shorthand like `rdf:type`. This function let's us do something similar.
// expect(rdf('type')).toEqual({ Iri: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' });
function rdf(keyword) {
  if (!['type', 'subject', 'predicate', 'object'].includes(keyword)) {
    throw `are you sure ${keyword} is part of the rdf: context?`;
  }
  return { Iri: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' + keyword };
}
