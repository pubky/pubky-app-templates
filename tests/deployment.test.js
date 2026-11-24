import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createSiteServer } from '../server.js'

const { fetch } = globalThis

let directory
let server
let origin

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'templates-deployment-'))
  const files = {
    'index.html': '<h1>Templates</h1>',
    'style.css': 'body { color: black; }',
    'basic-pubky-app/index.html':
      '<meta http-equiv="refresh" content="0; url=../mainnet/basic-pubky-app/">',
    'mainnet/basic-pubky-app/index.html': '<h1>Mainnet</h1>',
    'mainnet/basic-pubky-app/tools.html': '<h1>Mainnet tools</h1>',
    'mainnet/basic-pubky-app/public-reader.html': '<h1>Mainnet reader</h1>',
    'mainnet/basic-pubky-app/assets/app.js': 'console.log("mainnet")',
    'testnet/basic-pubky-app/index.html': '<h1>Testnet</h1>',
    'testnet/basic-pubky-app/tools.html': '<h1>Testnet tools</h1>',
    'testnet/basic-pubky-app/public-reader.html': '<h1>Testnet reader</h1>',
    'testnet/basic-pubky-app/assets/app.js': 'console.log("testnet")',
    'vite-starter/index.html': '<h1>Vite starter</h1>',
  }
  for (const [pathname, content] of Object.entries(files)) {
    const file = join(directory, pathname)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, content)
  }

  server = createSiteServer(directory)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('serves the landing page and independent preview entrypoints', async () => {
  for (const [pathname, title] of [
    ['/', 'Templates'],
    ['/mainnet/basic-pubky-app/', 'Mainnet'],
    ['/testnet/basic-pubky-app/', 'Testnet'],
    ['/vite-starter/', 'Vite starter'],
  ]) {
    const response = await fetch(origin + pathname)
    assert.equal(response.status, 200, pathname)
    assert.match(response.headers.get('content-type'), /text\/html/)
    assert.equal(await response.text(), `<h1>${title}</h1>`)
  }
})

test('canonicalizes preview directories with relative redirects and preserved queries', async () => {
  for (const pathname of [
    '/basic-pubky-app',
    '/mainnet/basic-pubky-app',
    '/testnet/basic-pubky-app',
    '/vite-starter',
  ]) {
    const response = await fetch(`${origin}${pathname}?example=1`, { redirect: 'manual' })
    assert.equal(response.status, 308, pathname)
    assert.equal(response.headers.get('location'), `${pathname}/?example=1`)
  }
})

test('preserves HTML tools, reader pages, and the legacy mainnet redirect', async () => {
  for (const network of ['mainnet', 'testnet']) {
    for (const page of ['tools.html', 'public-reader.html']) {
      const response = await fetch(`${origin}/${network}/basic-pubky-app/${page}`, {
        redirect: 'manual',
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('location'), null)
    }
  }

  const legacy = await fetch(`${origin}/basic-pubky-app/`)
  assert.equal(legacy.status, 200)
  assert.match(await legacy.text(), /url=\.\.\/mainnet\/basic-pubky-app\//)
})

test('serves assets with correct types and supports HEAD requests', async () => {
  const script = await fetch(`${origin}/mainnet/basic-pubky-app/assets/app.js`)
  assert.equal(script.status, 200)
  assert.match(script.headers.get('content-type'), /javascript/)

  const stylesheet = await fetch(`${origin}/style.css`, { method: 'HEAD' })
  assert.equal(stylesheet.status, 200)
  assert.match(stylesheet.headers.get('content-type'), /text\/css/)
  assert.equal(await stylesheet.text(), '')
})

test('unknown routes, missing assets, and runtime files return 404 instead of another app', async () => {
  for (const pathname of [
    '/missing/',
    '/mainnet/basic-pubky-app/missing/',
    '/testnet/basic-pubky-app/assets/missing.js',
    '/mainnet/basic-pubky-app/assets/',
    '/package.json',
    '/server.js',
    '/.env',
  ]) {
    const response = await fetch(origin + pathname)
    assert.equal(response.status, 404, pathname)
  }
})
