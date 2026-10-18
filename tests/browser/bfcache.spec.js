import { test, expect } from './browser-test.js'

const accountId = 'browser-test:template'

async function openApp(page, signedIn = true) {
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
  await page.goto('/')
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

test('a cached sign-in request resumes and a cached public reader remains usable', async ({
  page,
}) => {
  await openApp(page, false)
  await page.getByRole('link', { name: 'Public file reader', exact: true }).click()
  const address =
    'pubky://8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo/pub/example/file.txt'
  await page.getByLabel('Pubky file address').fill(address)
  await page.getByRole('button', { name: 'Read public file', exact: true }).click()
  await expect(page.locator('.file-preview')).toHaveText('A public file')
  await page.goBack({ waitUntil: 'commit' })
  await expectCachedRestore(page)
  await expect(page.locator('#authorize-ring')).toBeVisible()
  await page.evaluate(() => globalThis.__pubkyTest.approveSignIn())
  await expect(page.locator('#sign-out')).toBeEnabled()
  await page.goForward({ waitUntil: 'commit' })
  await expectCachedRestore(page)
  await expect(page.locator('.file-preview')).toHaveText('A public file')
  await page.getByRole('button', { name: 'Read public file', exact: true }).click()
  await expect(page.locator('#storage-tools-status')).toHaveText(
    'Public file loaded without authentication.',
  )
})
