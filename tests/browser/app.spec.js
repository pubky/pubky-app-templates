import { test as base, expect } from '@playwright/test'
import { URL } from 'node:url'
import { Buffer } from 'node:buffer'

const owner = '8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo'
const publicAddress = `pubky://${owner}/pub/example/file.txt`
const notePath = '/pub/template/files/existing.json'
const uploadPath = '/pub/template/attachments/example.bin'
const note = {
  json: { title: 'Existing note', body: 'Saved body', updatedAt: '2026-01-01T00:00:00.000Z' },
}
const upload = { bytes: [0, 128, 255], metadata: { contentLength: 3 } }

const test = base.extend({
  page: async ({ page }, use) => {
    const externalRequests = []
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.context().on('page', (otherPage) => {
      otherPage.on('pageerror', (error) => errors.push(error.message))
    })
    await page.context().route('**/*', (route) => {
      const url = new URL(route.request().url())
      if (url.origin === 'http://127.0.0.1:4175') return route.continue()
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    })
    await use(page)
    expect(externalRequests, 'Tests must never contact real relays or homeservers').toEqual([])
    expect(errors, 'Uncaught browser errors').toEqual([])
  },
})

async function openApp(page, { signedIn = true, files = {}, directories = [] } = {}) {
  await page.addInitScript(
    ({ signedIn, files, directories }) => {
      globalThis.__pubkySeed = { files, directories }
      if (!globalThis.sessionStorage.getItem('test-initialized')) {
        globalThis.sessionStorage.setItem('test-initialized', 'true')
        if (signedIn) globalThis.localStorage.setItem('template:session', 'browser-test:template')
      }
    },
    { signedIn, files, directories },
  )
  await page.goto('/')
  await expect(page.locator(signedIn ? '#file-form' : '#authorize-ring')).toBeVisible()
  await expect(page.locator(signedIn ? '#sign-out' : '#refresh-ring-signin')).toBeEnabled()
}

async function failNext(page, method, message = 'Simulated unavailable service') {
  await page.evaluate(
    ({ method, message }) => {
      globalThis.__pubkyTest.failures[method] = message
    },
    { method, message },
  )
}

async function calls(page, method) {
  return page.evaluate(
    (method) => globalThis.__pubkyTest.calls.filter((call) => call.method === method),
    method,
  )
}

async function fillNote(page) {
  await page.getByLabel('Title', { exact: true }).fill('A new note')
  await page.getByLabel('Body', { exact: true }).fill('Keep this text on a failed write')
}

const submit = (page) => page.locator('#file-form button[type="submit"]')

test('one saved session restores after reload without account picker controls', async ({
  page,
}) => {
  await openApp(page)
  await expect(page.locator('#saved-accounts, #add-account')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeEnabled()
  await page.reload()
  await expect(page.locator('#file-form')).toBeVisible()
  await expect(page.locator('#sign-out')).toBeEnabled()
  await expect(page.locator('#saved-accounts, #add-account')).toHaveCount(0)
  expect(await calls(page, 'sessions.restore')).toHaveLength(1)
  expect(await calls(page, 'sessions.list')).toHaveLength(0)
  expect(
    await page.evaluate(() => globalThis.localStorage.getItem('template:session:accounts')),
  ).toBeNull()
})

test('failed signout retains the session and must be retried before signing in again', async ({
  page,
}) => {
  await openApp(page)
  await failNext(page, 'signout')
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.locator('#status')).toContainText('Simulated unavailable service')
  await expect(page.getByRole('button', { name: 'Retry sign out', exact: true })).toBeEnabled()
  await expect(page.locator('#authorize-ring, #saved-accounts, #add-account')).toHaveCount(0)
  await expect(page.locator('#file-form')).toHaveCount(0)
  expect(await page.evaluate(() => globalThis.localStorage.getItem('template:session'))).toBe(
    'browser-test:template',
  )
  await page.getByRole('button', { name: 'Retry sign out', exact: true }).click()
  await expect(page.locator('#authorize-ring')).toBeVisible()
  await expect(page.locator('#file-form')).toHaveCount(0)
  expect(await page.evaluate(() => globalThis.localStorage.getItem('template:session'))).toBeNull()
  expect(await calls(page, 'signout')).toHaveLength(2)
})

test('signout and the next Ring signin update another tab without an account picker', async ({
  page,
}) => {
  await openApp(page)
  const otherPage = await page.context().newPage()
  await otherPage.goto('/')
  await expect(otherPage.locator('#file-form')).toBeVisible()
  await expect(otherPage.locator('#sign-out')).toBeEnabled()
  await fillNote(otherPage)

  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.locator('#authorize-ring')).toBeVisible()
  await expect(otherPage.locator('#authorize-ring')).toBeVisible()
  await expect(otherPage.locator('#file-form')).toHaveCount(0)

  await expect
    .poll(() => page.evaluate(() => typeof globalThis.__pubkyTest.approveSignIn))
    .toBe('function')
  await page.evaluate(() => globalThis.__pubkyTest.approveSignIn())
  await expect(page.locator('#file-form')).toBeVisible()
  await expect(otherPage.locator('#file-form')).toBeVisible()
  await expect(otherPage.getByLabel('Title', { exact: true })).toHaveValue('')
  await expect(otherPage.locator('#saved-accounts, #add-account')).toHaveCount(0)
  expect(await calls(page, 'sessions.save')).toHaveLength(1)
  expect(await calls(otherPage, 'sessions.restore')).toHaveLength(2)
})

test('shallow attachment directories do not hide either file list', async ({ page }) => {
  await openApp(page, {
    files: { [notePath]: note, [uploadPath]: upload },
    directories: ['/pub/template/attachments/nested/'],
  })
  await expect(page.locator('#files-list')).toContainText('Existing note')
  await expect(page.locator('#files-list')).toContainText('example.bin')
  await expect(page.locator('#files-list')).not.toContainText('nested')
  expect((await calls(page, 'stats')).map((call) => call.path)).not.toContain(
    '/pub/template/attachments/nested/',
  )
})

test('a failed note write retains the draft and restores controls for retry', async ({ page }) => {
  await openApp(page)
  await fillNote(page)
  await failNext(page, 'putJson')
  await submit(page).click()
  await expect(page.locator('#status')).toContainText('Simulated unavailable service')
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('A new note')
  await expect(page.getByLabel('Body', { exact: true })).toBeEnabled()
  await submit(page).click()
  await expect(page.locator('#status')).toContainText('File saved:')
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('')
  expect(await calls(page, 'putJson')).toHaveLength(2)
})

for (const failure of ['list:/pub/template/files/', 'list:/pub/template/attachments/', 'stats']) {
  test(`a saved note remains successful when refresh fails at ${failure}`, async ({ page }) => {
    await openApp(page)
    await fillNote(page)
    await failNext(page, failure)
    await submit(page).click()
    await expect(page.locator('#status')).toContainText('File saved:')
    await expect(page.locator('#status')).toContainText(/refresh/i)
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('Body', { exact: true })).toHaveValue('')
    await expect(page.locator('#files-list')).toContainText('A new note')
    await expect(submit(page)).toBeEnabled()
    expect(await calls(page, 'putJson')).toHaveLength(1)
    // Refreshing the workspace must not repeat the already successful write.
    await page.getByRole('button', { name: 'Private storage', exact: true }).click()
    await page.getByRole('button', { name: 'Public storage', exact: true }).click()
    await expect(page.locator('#files-list li')).toHaveCount(1)
    expect(await calls(page, 'putJson')).toHaveLength(1)
  })
}

for (const failWrite of [true, false]) {
  test(`an upload ${failWrite ? 'failure preserves the selected file for retry' : 'success survives a failed refresh'}`, async ({
    page,
  }) => {
    await openApp(page)
    await page.getByLabel('Choose a file', { exact: true }).check()
    const input = page.locator('input[type="file"]')
    await input.setInputFiles({
      name: 'upload.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([0, 128, 255]),
    })
    await failNext(page, failWrite ? 'putBytes' : 'list:/pub/template/attachments/')
    await submit(page).click()
    await expect(submit(page)).toBeEnabled()
    if (failWrite) {
      await expect(page.locator('#status')).toContainText('Simulated unavailable service')
      expect(await input.evaluate((input) => input.files.length)).toBe(1)
      await submit(page).click()
    }
    await expect(page.locator('#status')).toContainText('File uploaded:')
    if (!failWrite) await expect(page.locator('#status')).toContainText(/refresh/i)
    expect(await input.evaluate((input) => input.files.length)).toBe(0)
    await expect(page.locator('#files-list')).toContainText('upload.bin')
    await submit(page).click()
    expect(await calls(page, 'putBytes')).toHaveLength(failWrite ? 2 : 1)
  })
}

test('a completed save clears its draft before a slow refresh finishes', async ({ page }) => {
  await openApp(page)
  await fillNote(page)
  await page.evaluate(() => {
    globalThis.__pubkyTest.holdLists = true
  })
  await submit(page).click()
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('')
  await expect(page.locator('#files-list')).toContainText('A new note')
  await expect(submit(page)).toBeDisabled()
  expect(await calls(page, 'putJson')).toHaveLength(1)
  await page.evaluate(() => {
    globalThis.__pubkyTest.holdLists = false
    globalThis.__pubkyTest.pendingLists.forEach((resolve) => resolve())
  })
  await expect(submit(page)).toBeEnabled()
  await expect(page.locator('#status')).toContainText('File saved:')
})

for (const kind of ['note', 'upload']) {
  for (const failWrite of [true, false]) {
    test(`${kind} deletion ${failWrite ? 'failure leaves the row available for retry' : 'success removes the row despite a failed refresh'}`, async ({
      page,
    }) => {
      await openApp(page, { files: { [notePath]: note, [uploadPath]: upload } })
      const method = kind === 'note' ? 'deleteLocked' : 'delete'
      const row = page
        .locator('#files-list li')
        .filter({ hasText: kind === 'note' ? 'Existing note' : 'example.bin' })
      await failNext(page, failWrite ? method : 'list')
      await row.getByRole('button', { name: 'Delete', exact: true }).click()
      if (failWrite) {
        await expect(page.locator('#status')).toContainText('Simulated unavailable service')
        await expect(row.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled()
        await row.getByRole('button', { name: 'Delete', exact: true }).click()
      }
      await expect(page.locator('#status')).toContainText('File deleted:')
      if (!failWrite) await expect(page.locator('#status')).toContainText(/refresh/i)
      await expect(row).toHaveCount(0)
      await expect(submit(page)).toBeEnabled()
      expect(await calls(page, method)).toHaveLength(failWrite ? 2 : 1)
    })
  }
}

test('a completed note deletion stays successful when unlock fails', async ({ page }) => {
  await openApp(page, { files: { [notePath]: note } })
  await failNext(page, 'unlock')
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('#status')).toContainText('File deleted:')
  await expect(page.locator('#files-list li')).toHaveCount(0)
  await expect(submit(page)).toBeEnabled()
  expect(await calls(page, 'deleteLocked')).toHaveLength(1)
  expect(await calls(page, 'unlock')).toHaveLength(1)
})

test('authenticated oversized downloads cancel their stream and restore controls', async ({
  page,
}) => {
  await openApp(page, { files: { [uploadPath]: { streamSize: 32 * 1024 * 1024, metadata: {} } } })
  await page.locator('[data-upload-action="download"]').click()
  await expect(page.locator('#status')).toContainText('5 MiB')
  await expect(page.locator('[data-upload-action="download"]')).toBeEnabled()
  expect(await page.evaluate(() => globalThis.__pubkyTest.streamCanceled)).toBe(true)
  expect(await page.evaluate(() => globalThis.__pubkyTest.streamBytes)).toBeLessThan(
    7 * 1024 * 1024,
  )
  expect(await calls(page, 'getBytes')).toHaveLength(0)
})

test('the public reader escapes remote text and metadata and rejects private addresses locally', async ({
  page,
}) => {
  await page.goto('/public-reader.html')
  await page.evaluate(() => {
    globalThis.__pubkyTest.publicFile = {
      body: '<img src=x onerror="globalThis.injected=true"><script>globalThis.injected=true</script>',
      metadata: {
        contentType: 'text/plain',
        etag: '<img src=x onerror="globalThis.injected=true">',
      },
    }
  })
  await page.getByLabel('Pubky file address').fill(publicAddress)
  await page.getByRole('button', { name: 'Read public file', exact: true }).click()
  await expect(page.locator('#storage-tools-status')).toContainText('without authentication')
  await expect(page.locator('.file-preview')).toContainText('<script>')
  await expect(page.locator('#public-file-result img, #public-file-result script')).toHaveCount(0)
  expect(await page.evaluate(() => globalThis.injected)).toBeUndefined()
  await page.getByLabel('Pubky file address').fill(publicAddress.replace('/pub/', '/priv/'))
  await page.getByRole('button', { name: 'Read public file', exact: true }).click()
  await expect(page.locator('#storage-tools-status')).toContainText('/pub/ only')
  await expect(page.locator('#public-file-result')).toBeEmpty()
  await expect(page.getByRole('button', { name: 'Read public file', exact: true })).toBeEnabled()
  expect(await calls(page, 'public.get')).toHaveLength(1)
  expect(await calls(page, 'sessions.restore')).toHaveLength(0)
  expect(await calls(page, 'sessions.list')).toHaveLength(0)
})

test('an oversized public stream is canceled and a later read recovers', async ({ page }) => {
  await page.goto('/public-reader.html')
  await page.evaluate(() => {
    globalThis.__pubkyTest.publicFile = { streamSize: 32 * 1024 * 1024, metadata: {} }
  })
  await page.getByLabel('Pubky file address').fill(publicAddress)
  await page.getByRole('button', { name: 'Read public file', exact: true }).click()
  await expect(page.locator('#storage-tools-status')).toContainText('5 MiB')
  expect(await page.evaluate(() => globalThis.__pubkyTest.streamCanceled)).toBe(true)
  expect(await page.evaluate(() => globalThis.__pubkyTest.streamBytes)).toBeLessThan(
    7 * 1024 * 1024,
  )
  await page.evaluate(() => {
    globalThis.__pubkyTest.publicFile = {
      body: 'Recovered',
      metadata: { contentType: 'text/plain' },
    }
  })
  await page.getByRole('button', { name: 'Read public file', exact: true }).click()
  await expect(page.locator('.file-preview')).toHaveText('Recovered')
})

for (const signedIn of [true, false]) {
  test(`page links and browser Back/Forward recover the ${signedIn ? 'signed-in' : 'signed-out'} view`, async ({
    page,
  }) => {
    await openApp(page, { signedIn })
    await page.getByRole('link', { name: 'Public file reader', exact: true }).click()
    await expect(page.locator('#public-reader')).toBeVisible()
    await page.goBack()
    await expect(page.locator(signedIn ? '#file-form' : '#authorize-ring')).toBeVisible()
    await expect(page.locator(signedIn ? '#sign-out' : '#refresh-ring-signin')).toBeEnabled()
    await page.goForward()
    await expect(page.locator('#public-reader')).toBeVisible()
    await page.getByRole('link', { name: 'Your files', exact: true }).click()
    await expect(page.locator(signedIn ? '#file-form' : '#authorize-ring')).toBeVisible()
    if (signedIn) {
      await page.getByRole('button', { name: 'Sign out', exact: true }).click()
      await expect(page.locator('#authorize-ring')).toBeVisible()
      await page.getByRole('link', { name: 'Public file reader', exact: true }).click()
      await page.getByRole('link', { name: 'Your files', exact: true }).click()
      await expect(page.locator('#file-form')).toHaveCount(0)
      await expect(page.locator('#authorize-ring')).toBeVisible()
    }
  })
}

test('removing the optional events panel leaves file operations usable', async ({ page }) => {
  await openApp(page)
  await page
    .getByRole('heading', { name: 'Events', exact: true })
    .evaluate((heading) => heading.closest('section').remove())
  await fillNote(page)
  await submit(page).click()
  await expect(page.locator('#status')).toContainText('File saved:')
  await expect(page.locator('#files-list')).toContainText('A new note')
  await expect(submit(page)).toBeEnabled()
})
