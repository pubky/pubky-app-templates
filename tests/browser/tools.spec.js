import { test, expect } from './browser-test.js'

async function seedSession(page, { signedIn = true, capabilities } = {}) {
  await page.addInitScript(
    ({ signedIn, capabilities }) => {
      globalThis.__pubkySeed = {
        capabilities,
        persistentFailures: { list: 'Tools must not load file lists' },
      }
      if (!globalThis.sessionStorage.getItem('test-initialized')) {
        globalThis.sessionStorage.setItem('test-initialized', 'true')
        if (signedIn) {
          globalThis.localStorage.setItem('template:session', 'browser-test:template')
          globalThis.localStorage.setItem(
            'test-sdk-records',
            JSON.stringify(['browser-test:template']),
          )
        }
      }
    },
    { signedIn, capabilities },
  )
}

for (const signedIn of [true, false]) {
  test(`Tools navigation preserves the ${signedIn ? 'signed-in' : 'signed-out'} account state`, async ({
    page,
  }) => {
    await seedSession(page, { signedIn })
    await page.goto('/')
    await expect(page.locator(signedIn ? '#sign-out' : '#authorize-ring')).toBeVisible()
    await expect(page.locator('#proof-tools, #encryption-recovery')).toHaveCount(0)
    await page.getByRole('link', { name: 'Tools', exact: true }).click()
    await expect(page).toHaveURL(/\/tools\.html$/)
    await expect(page.locator('nav [aria-current="page"]')).toHaveText('Tools')
    await expect(page.locator('#file-form, #storage-workspace')).toHaveCount(0)
    if (signedIn) {
      await expect(page.locator('#proof-tools')).toBeVisible()
      await expect(page.locator('#encryption-recovery')).toBeVisible()
    } else {
      await expect(page.locator('#authorize-ring')).toBeVisible()
      await expect(page.locator('#proof-tools, #encryption-recovery')).toHaveCount(0)
    }
    await page.getByRole('link', { name: 'Public file reader', exact: true }).click()
    await expect(page.locator('#public-reader')).toBeVisible()
    await page.getByRole('link', { name: 'Tools', exact: true }).click()
    await expect(page.locator(signedIn ? '#proof-tools' : '#authorize-ring')).toBeVisible()
    await page.getByRole('link', { name: 'Your files', exact: true }).click()
    await expect(page.locator(signedIn ? '#file-form' : '#authorize-ring')).toBeVisible()
    await expect(page.locator('#proof-tools, #encryption-recovery')).toHaveCount(0)
  })
}

for (const capabilities of [undefined, []]) {
  test(`Tools opens without file requests ${capabilities ? 'when storage is not approved' : 'when file storage is unavailable'}`, async ({
    page,
  }) => {
    await seedSession(page, { capabilities })
    await page.goto('/tools.html')
    await expect(page.locator('#proof-form button')).toBeEnabled()
    await expect(page.locator('#encryption-recovery')).toBeVisible()
    await expect(page.locator('#status')).not.toContainText('No folder has read access')
    expect(
      await page.evaluate(() =>
        globalThis.__pubkyTest.calls.filter((call) =>
          ['list', 'stats', 'getJson', 'events.subscribe'].includes(call.method),
        ),
      ),
    ).toEqual([])
  })
}

test('Tools clears proof and recovery panels when another tab signs out', async ({ page }) => {
  await seedSession(page)
  await page.goto('/tools.html')
  await expect(page.locator('#proof-form button')).toBeEnabled()
  await page.locator('#proof-form textarea').fill('Message from the old session')
  const otherPage = await page.context().newPage()
  await otherPage.goto('/')
  await expect(otherPage.locator('#sign-out')).toBeEnabled()
  await otherPage.locator('#sign-out').click()
  await expect(otherPage.locator('#authorize-ring')).toBeVisible()
  await expect(page.locator('#authorize-ring')).toBeVisible()
  await expect(page.locator('#proof-tools, #encryption-recovery')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('Message from the old session')
  await otherPage.close()
})
