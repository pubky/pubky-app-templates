import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createPrivateKey, randomBytes, sign } from 'node:crypto'
import { after, before, test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { Keypair, verifyCustomGrantPop } from '@synonymdev/pubky'
import { createServer } from 'vite'

let server
let proofs

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    envFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    logLevel: 'error',
  })
  proofs = await server.ssrLoadModule('/src/proofs.ts')
})

after(async () => {
  await server?.close()
})

// Disposable Ed25519 fixtures follow the SDK's tagged CUSTOM_POP.md wire contract.
// Real SDK verification checks both signatures; production helpers contain no test signer.
function testKey() {
  const keypair = Keypair.random()
  const publicKey = keypair.publicKey
  const identity = publicKey.z32()
  const secret = keypair.secret()
  try {
    return {
      identity,
      privateKey: createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), secret]),
        format: 'der',
        type: 'pkcs8',
      }),
    }
  } finally {
    secret.fill(0)
    publicKey.free()
    keypair.free()
  }
}

function jws(key, type, claims) {
  const input = [
    Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: type })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
  ].join('.')
  return `${input}.${sign(null, Buffer.from(input), key.privateKey).toString('base64url')}`
}

function fixture({ data = {}, clientId = 'template', proofAge = 0, expiresIn = 3600 } = {}) {
  const root = testKey()
  const client = testKey()
  const now = Math.floor(Date.now() / 1000)
  const expected = { identity: root.identity, audience: 'https://example.test', challenge: 'fresh' }
  const claims = {
    iss: root.identity,
    client_id: clientId,
    caps: [],
    cnf: client.identity,
    jti: randomBytes(16).toString('base64url'),
    iat: now - 1000,
    exp: now + expiresIn,
  }
  const payload = {
    gid: claims.jti,
    iat: now - proofAge,
    nonce: randomBytes(16).toString('base64url'),
    data: {
      audience: expected.audience,
      purpose: 'template-proof-demo',
      challenge: expected.challenge,
      message: 'A signed message',
      ...data,
    },
  }
  const credentials = {
    grant: jws(root, 'pubky-grant', claims),
    pop: jws(client, 'pubky-custom-pop-v1', payload),
  }
  return { credentials, expected, root, client, claims, payload }
}

test('real root and client signatures verify locally with the application challenge', () => {
  const { credentials, expected } = fixture()
  const verified = proofs.verifyAppProof(credentials, expected, new Map())
  assert.equal(verified.identity, expected.identity)
  assert.equal(verified.message, 'A signed message')
  assert.ok(Math.abs(verified.signedAt - Date.now() / 1000) < 2)
})

test('changing signed data or substituting a root signature is rejected by SDK verification', () => {
  const { credentials, expected, payload, claims } = fixture()
  const [header, , signature] = credentials.pop.split('.')
  const changed = Buffer.from(
    JSON.stringify({ ...payload, data: { message: 'tampered' } }),
  ).toString('base64url')
  assert.throws(() =>
    proofs.verifyAppProof(
      { ...credentials, pop: `${header}.${changed}.${signature}` },
      expected,
      new Map(),
    ),
  )
  assert.throws(() =>
    proofs.verifyAppProof(
      { ...credentials, grant: jws(testKey(), 'pubky-grant', claims) },
      expected,
      new Map(),
    ),
  )
})

test('valid signatures cannot substitute another identity or application', () => {
  const { credentials, expected } = fixture()
  assert.throws(
    () =>
      proofs.verifyAppProof(credentials, { ...expected, identity: testKey().identity }, new Map()),
    /different identity or application/,
  )
  const otherClient = fixture({ clientId: 'another-app' })
  assert.throws(
    () => proofs.verifyAppProof(otherClient.credentials, otherClient.expected, new Map()),
    /different identity or application/,
  )
})

for (const data of [
  { audience: 'https://attacker.test' },
  { purpose: 'authorize-a-transfer' },
  { challenge: 'old' },
  { message: 42 },
  { extra: 'unexpected' },
]) {
  test(`rejects a signed message with mismatched ${Object.keys(data)[0]}`, () => {
    const { credentials, expected } = fixture({ data })
    assert.throws(
      () => proofs.verifyAppProof(credentials, expected, new Map()),
      /does not match this message exchange/,
    )
  })
}

test('an old proof accepted by the stateless SDK is rejected by the application freshness window', () => {
  const { credentials, expected } = fixture({ proofAge: 61 })
  assert.ok(verifyCustomGrantPop(credentials))
  assert.throws(
    () => proofs.verifyAppProof(credentials, expected, new Map()),
    /outside the allowed time window/,
  )
  const boundary = fixture({ proofAge: 60 })
  assert.ok(proofs.verifyAppProof(boundary.credentials, boundary.expected, new Map()))
})

test('expired grants fail and nonce reuse is rejected until grant expiry', () => {
  const expired = fixture({ proofAge: 10, expiresIn: -1 })
  assert.throws(() => proofs.verifyAppProof(expired.credentials, expired.expected, new Map()))
  const { credentials, expected, claims } = fixture()
  const seen = new Map([['expired-record', Math.floor(Date.now() / 1000) - 1]])
  proofs.verifyAppProof(credentials, expected, seen)
  assert.equal(seen.has('expired-record'), false)
  assert.deepEqual([...seen.values()], [claims.exp])
  assert.throws(() => proofs.verifyAppProof(credentials, expected, seen), /already been used/)
})

test('oversized signed messages and transport bundles are rejected', () => {
  const oversized = fixture({ data: { message: 'é'.repeat(2049) } })
  assert.throws(
    () => proofs.verifyAppProof(oversized.credentials, oversized.expected, new Map()),
    /at most 4 KiB/,
  )
  assert.throws(
    () =>
      proofs.verifyAppProof({ grant: 'x'.repeat(32769), pop: 'x' }, oversized.expected, new Map()),
    /oversized proof bundle/,
  )
  assert.throws(() =>
    proofs.verifyAppProof({ grant: 'malformed', pop: 'malformed' }, oversized.expected, new Map()),
  )
})

test('signing uses the delegated grant and frees its owned view on success or failure', async () => {
  let received
  let freed = 0
  const credentials = fixture().credentials
  const grant = {
    createCustomPop: async (data) => {
      received = data
      return credentials
    },
    free() {
      freed++
    },
  }
  assert.equal(
    await proofs.createAppProof({ grant }, 'Hello', 'https://example.test', 'challenge'),
    credentials,
  )
  assert.deepEqual(received, {
    audience: 'https://example.test',
    purpose: 'template-proof-demo',
    challenge: 'challenge',
    message: 'Hello',
  })
  assert.equal(freed, 1)
  grant.createCustomPop = async () => {
    throw new Error('Signing failed')
  }
  await assert.rejects(
    proofs.createAppProof({ grant }, 'Hello', 'https://example.test', 'challenge'),
    /Signing failed/,
  )
  assert.equal(freed, 2)
  await assert.rejects(
    proofs.createAppProof({}, 'Hello', 'https://example.test', 'challenge'),
    /grant session/,
  )
  await assert.rejects(
    proofs.createAppProof({ grant }, 'é'.repeat(2049), 'https://example.test', 'challenge'),
    /at most 4 KiB/,
  )
  assert.equal(freed, 2, 'oversized messages never reach the signer')
})
