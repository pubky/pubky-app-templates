import { test, expect } from './browser-test.js'

const accountId = 'browser-test:template'

async function openApp(page, signedIn = true, path = '/') {
  await page.addInitScript(
    ({ accountId, signedIn }) => {
      globalThis.__pubkySeed = { files: {} }
      globalThis.__pageShows = []
      globalThis.window.addEventListener('pageshow', (event) =>
        globalThis.__pageShows.push(event.persisted),
      )
      if (!globalThis.sessionStorage.getItem('test-initialized')) {
        globalThis.sessionStorage.setItem('test-initialized', 'true')
        if (signedIn) {
          globalThis.localStorage.setItem('template:session', accountId)
          globalThis.localStorage.setItem('test-sdk-records', JSON.stringify([accountId]))
        }
      }
    },
    { accountId, signedIn },
  )
  await page.goto(path)
  await expect(page.locator(signedIn ? '#sign-out' : '#refresh-ring-signin')).toBeEnabled()
}

async function expectCachedRestore(page) {
  await expect.poll(() => page.evaluate(() => globalThis.__pageShows.at(-1))).toBe(true)
}

test('Back restores the same session draft from the actual browser cache', async ({ page }) => {
  await openApp(page)
  await page.locator('textarea[name="body"]').fill('Keep my cached draft')
  await page.getByRole('link', { name: 'Public file reader', exact: true }).click()
  // Cached documents resume at commit without firing another load event.
  await page.goBack({ waitUntil: 'commit' })
  await expectCachedRestore(page)
  await expect(page.locator('#sign-out')).toBeEnabled()
  await expect(page.locator('textarea[name="body"]')).toHaveValue('Keep my cached draft')
})

test('Back discards cached private content after another tab signs out', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: 'Private storage', exact: true }).click()
  await page.locator('textarea[name="body"]').fill('Private cached draft')
  await page.getByRole('link', { name: 'Public file reader', exact: true }).click()
  const otherPage = await page.context().newPage()
  await otherPage.goto('/')
  await expect(otherPage.locator('#sign-out')).toBeEnabled()
  await otherPage.locator('#sign-out').click()
  await expect(otherPage.locator('#authorize-ring')).toBeVisible()
  await otherPage.close()
  await page.goBack({ waitUntil: 'commit' })
  await expectCachedRestore(page)
  await expect(page.locator('#authorize-ring')).toBeVisible()
  await expect(page.locator('#file-form')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('Private cached draft')
})

test('a cached sign-in request resumes and the public reader remains usable after Forward', async ({
  page,
}) => {
  await openApp(page, false)
  await page.getByRole('link', { name: 'Public file reader', exact: true }).click()
  const address =
    'pubky://8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo/pub/example/file.txt'
  await page.getByLabel('Pubky file address').fill(address)
  await page.getByRole('button', { name: 'Read public file', exact: true }).click()
  await expect(page.locator('.file-preview')).toHaveText('A public file')
  // Only the reader's next pageshow should identify the Forward navigation outcome.
  await page.evaluate(() => {
    globalThis.__pageShows = []
  })
  await page.goBack({ waitUntil: 'commit' })
  await expectCachedRestore(page)
  await expect(page.locator('#authorize-ring')).toBeVisible()
  await page.evaluate(() => globalThis.__pubkyTest.approveSignIn())
  await expect(page.locator('#sign-out')).toBeEnabled()
  await page.goForward({ waitUntil: 'commit' })
  await expect.poll(() => page.evaluate(() => typeof globalThis.__pageShows.at(-1))).toBe('boolean')
  if (await page.evaluate(() => globalThis.__pageShows.at(-1))) {
    await expect(page.locator('.file-preview')).toHaveText('A public file')
  } else {
    // Chromium may evict the reader while sign-in completes. A reload is valid too.
    await page.getByLabel('Pubky file address').fill(address)
  }
  await page.getByRole('button', { name: 'Read public file', exact: true }).click()
  await expect(page.locator('.file-preview')).toHaveText('A public file')
  await expect(page.locator('#storage-tools-status')).toHaveText(
    'Public file loaded without authentication.',
  )
})

test('Back to Tools discards cached proof content after another tab signs out', async ({
  page,
}) => {
  await openApp(page, true, '/tools.html')
  await expect(page.locator('#proof-tools')).toBeVisible()
  await page.locator('#proof-form textarea').fill('Private cached proof message')
  await page.getByRole('link', { name: 'Public file reader', exact: true }).click()
  const otherPage = await page.context().newPage()
  await otherPage.goto('/')
  await expect(otherPage.locator('#sign-out')).toBeEnabled()
  await otherPage.locator('#sign-out').click()
  await expect(otherPage.locator('#authorize-ring')).toBeVisible()
  await otherPage.close()
  await page.goBack({ waitUntil: 'commit' })
  await expectCachedRestore(page)
  await expect(page.locator('#authorize-ring')).toBeVisible()
  await expect(page.locator('#proof-tools')).toHaveCount(0)
  await expect(page.locator('#encryption-recovery')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('Private cached proof message')
})
