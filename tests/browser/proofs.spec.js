import { Buffer } from 'node:buffer'
import { createPrivateKey, randomBytes, sign } from 'node:crypto'
import { Keypair } from '../../basic-pubky-app/node_modules/@synonymdev/pubky/index.js'
import { test, expect } from './browser-test.js'

function disposableKey() {
  const pair = Keypair.random()
  const publicKey = pair.publicKey
  const identity = publicKey.z32()
  const secret = pair.secret()
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
    pair.free()
  }
}

function signJws(key, type, claims) {
  const input = [
    Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: type })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
  ].join('.')
  return `${input}.${sign(null, Buffer.from(input), key.privateKey).toString('base64url')}`
}

function proofSigner() {
  const root = disposableKey()
  const client = disposableKey()
  const now = Math.floor(Date.now() / 1000)
  const grantId = randomBytes(16).toString('base64url')
  const grant = signJws(root, 'pubky-grant', {
    iss: root.identity,
    client_id: 'template',
    caps: [],
    cnf: client.identity,
    jti: grantId,
    iat: now - 10,
    exp: now + 3600,
  })
  return {
    identity: root.identity,
    credentials(data) {
      return {
        grant,
        pop: signJws(client, 'pubky-custom-pop-v1', {
          gid: grantId,
          iat: Math.floor(Date.now() / 1000),
          nonce: randomBytes(16).toString('base64url'),
          data,
        }),
      }
    },
  }
}

async function openSignedApp(page, identity) {
  await page.addInitScript((publicKey) => {
    globalThis.__pubkySeed = { publicKey }
    globalThis.localStorage.setItem('template:session', 'browser-test:template')
    globalThis.localStorage.setItem('test-sdk-records', JSON.stringify(['browser-test:template']))
  }, identity)
  await page.goto('/')
  await expect(page.locator('#proof-tools')).toBeVisible()
  await expect(page.locator('#proof-form button')).toBeEnabled()
}

test('custom proofs use real signature verification and display signed messages as text', async ({
  page,
}) => {
  const signer = proofSigner()
  await page.route('**/__test_custom_pop', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(signer.credentials(route.request().postDataJSON())),
    })
  })
  await openSignedApp(page, signer.identity)
  const message = '<img src="/__unexpected-proof-image" onerror="globalThis.__proofExecuted=true">'
  await page.locator('#proof-form textarea').fill(message)
  await page.getByRole('button', { name: 'Sign and verify', exact: true }).click()
  await expect(page.locator('#proof-status')).toHaveText(
    'Message signature and challenge verified locally.',
  )
  await expect(page.locator('#proof-result')).toHaveText(
    `Verified identity: ${signer.identity}\nSigned message: ${message}`,
  )
  await expect(page.locator('#proof-result img')).toHaveCount(0)
  expect(await page.evaluate(() => globalThis.__proofExecuted)).toBeUndefined()
  await expect(page.locator('#proof-form button')).toBeEnabled()
})

test('signing completion after sign-out cannot restore the message or proof panel', async ({
  page,
}) => {
  const signer = proofSigner()
  let heldRoute
  await page.route('**/__test_custom_pop', (route) => {
    heldRoute = route
  })
  await openSignedApp(page, signer.identity)
  const message = 'Late proof message must stay cleared'
  await page.locator('#proof-form textarea').fill(message)
  await page.getByRole('button', { name: 'Sign and verify', exact: true }).click()
  await expect.poll(() => Boolean(heldRoute)).toBe(true)
  await expect(page.locator('#proof-form button')).toBeDisabled()
  await page.evaluate(() => {
    globalThis.__disposedProofPanel = globalThis.document.querySelector('#proof-tools')
  })
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.locator('#authorize-ring')).toBeVisible()
  await expect(page.locator('#proof-tools')).toHaveCount(0)
  await heldRoute.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(signer.credentials(heldRoute.request().postDataJSON())),
  })
  await expect
    .poll(() =>
      page.evaluate(() =>
        globalThis.__pubkyTest.calls.some((call) => call.method === 'grant.customPopCompleted'),
      ),
    )
    .toBe(true)
  await expect(page.locator('#proof-tools')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(message)
  expect(
    await page.evaluate(() => ({
      message: globalThis.__disposedProofPanel.querySelector('textarea').value,
      result: globalThis.__disposedProofPanel.querySelector('#proof-result').textContent,
    })),
  ).toEqual({ message: '', result: '' })
})
