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

for (const modifyDraft of [false, true]) {
  test(`reopening a saved note after a concurrent refresh ${modifyDraft ? 'preserves a changed draft and reports a conflict' : 'loads the newer remote version'}`, async ({
    page,
  }) => {
    await openApp(page, { files: { [notePath]: note } })
    await page.getByRole('button', { name: 'Lock & edit', exact: true }).click()
    await page.locator('textarea[name="body"]').fill('My saved version')
    await page.evaluate(() => {
      globalThis.__pubkyTest.holdLists = true
    })
    await submit(page).click()
    await expect.poll(() => page.evaluate(() => globalThis.__pubkyTest.pendingLists.length)).toBe(2)
    await page.evaluate((path) => {
      globalThis.__pubkyTest.files[path].json = {
        title: 'Remote version',
        body: 'Other client saved this',
        updatedAt: '2026-02-01T00:00:00.000Z',
      }
      globalThis.__pubkyTest.holdLists = false
      globalThis.__pubkyTest.pendingLists.forEach((resolve) => resolve())
    }, notePath)
    await expect(page.locator('#files-list')).toContainText('Remote version')
    await expect(page.locator('textarea[name="body"]')).toHaveValue('My saved version')
    if (modifyDraft) await page.locator('textarea[name="body"]').fill('My next unsaved edit')
    await page.getByRole('button', { name: 'Lock & edit', exact: true }).click()
    if (modifyDraft) {
      await expect(page.locator('#status')).toContainText(
        'The file changed since you started editing',
      )
      await expect(page.locator('textarea[name="body"]')).toHaveValue('My next unsaved edit')
      await expect(submit(page)).toBeDisabled()
    } else {
      await expect(page.locator('textarea[name="body"]')).toHaveValue('Other client saved this')
      await expect(submit(page)).toBeEnabled()
    }
    expect(await calls(page, 'putTextLocked')).toHaveLength(1)
    expect(
      await page.evaluate((path) => globalThis.__pubkyTest.files[path].json.body, notePath),
    ).toBe('Other client saved this')
  })
}

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

test('a transient restore failure after reload offers retry without replacing the saved session', async ({
  page,
}) => {
  await openApp(page)
  await page.evaluate(() =>
    globalThis.sessionStorage.setItem(
      'test-failures',
      JSON.stringify({ 'sessions.restore': 'Restore temporarily unavailable' }),
    ),
  )
  await page.reload()
  await expect(page.locator('#retry-saved-session')).toBeEnabled()
  await expect(page.locator('#status')).toContainText('Restore temporarily unavailable')
  await expect(page.locator('#authorize-ring, #development-signup-form, #file-form')).toHaveCount(0)
  expect(await calls(page, 'startGrantAuthFlow')).toHaveLength(0)
  expect(await page.evaluate(() => globalThis.localStorage.getItem('template:session'))).toBe(
    'browser-test:template',
  )
  await page.locator('#retry-saved-session').click()
  await expect(page.locator('#file-form')).toBeVisible()
  expect(await calls(page, 'sessions.restore')).toHaveLength(2)
  expect(await calls(page, 'sessions.save')).toHaveLength(0)
  expect(await calls(page, 'startGrantAuthFlow')).toHaveLength(0)
})

test('pending signout survives reload and must finish revocation before another Ring signin', async ({
  page,
}) => {
  await openApp(page)
  await failNext(page, 'signout')
  await page.locator('#sign-out').click()
  await expect(page.getByRole('button', { name: 'Retry sign out', exact: true })).toBeEnabled()
  await page.reload()
  await expect(page.locator('#retry-saved-session')).toBeEnabled()
  await expect(page.locator('#authorize-ring, #development-signup-form, #file-form')).toHaveCount(0)
  expect(await calls(page, 'startGrantAuthFlow')).toHaveLength(0)
  expect(await calls(page, 'sessions.save')).toHaveLength(0)
  expect(await page.evaluate(() => globalThis.localStorage.getItem('template:session'))).toBe(
    'browser-test:template',
  )
  // A still-pending retry must not abandon revocation either.
  await page.locator('#retry-saved-session').click()
  await expect(page.locator('#retry-saved-session')).toBeEnabled()
  expect(await calls(page, 'sessions.restore')).toHaveLength(2)
  expect(await calls(page, 'startGrantAuthFlow')).toHaveLength(0)
  await page.evaluate(() => globalThis.sessionStorage.setItem('test-revocation-recovered', 'true'))
  await page.locator('#retry-saved-session').click()
  await expect(page.locator('#authorize-ring')).toBeVisible()
  expect(await page.evaluate(() => globalThis.localStorage.getItem('template:session'))).toBeNull()
  expect(await calls(page, 'sessions.remove')).toHaveLength(1)
  expect(await calls(page, 'startGrantAuthFlow')).toHaveLength(1)
})

test('an existing note can release, reacquire, renew, and save without losing its draft', async ({
  page,
}) => {
  await openApp(page, { files: { [notePath]: note } })
  await page.getByRole('button', { name: 'Lock & edit', exact: true }).click()
  await page.locator('textarea[name="body"]').fill('A draft across lock operations')
  await page.getByRole('button', { name: 'Release lock', exact: true }).click()
  await expect(submit(page)).toBeDisabled()
  await page.getByRole('button', { name: 'Lock & edit', exact: true }).click()
  await expect(page.locator('textarea[name="body"]')).toHaveValue('A draft across lock operations')
  await page.getByRole('button', { name: 'Renew lock', exact: true }).click()
  await expect(page.locator('#status')).toContainText('File lock renewed.')
  await expect(page.locator('textarea[name="body"]')).toHaveValue('A draft across lock operations')
  await submit(page).click()
  await expect(page.locator('#status')).toContainText('File saved:')
  expect(
    await page.evaluate((path) => globalThis.__pubkyTest.files[path].json.body, notePath),
  ).toBe('A draft across lock operations')
  expect(await calls(page, 'lock')).toHaveLength(2)
  expect(await calls(page, 'refreshLock')).toHaveLength(1)
  expect(await calls(page, 'putTextLocked')).toHaveLength(1)
  expect(await calls(page, 'unlock')).toHaveLength(2)
})

test('an expired lock cannot save and a concurrent change preserves the draft until explicitly reopened', async ({
  page,
}) => {
  await openApp(page, { files: { [notePath]: note } })
  await page.getByRole('button', { name: 'Lock & edit', exact: true }).click()
  await page.locator('textarea[name="body"]').fill('My unsaved work')
  await page.clock.setFixedTime(await page.evaluate(() => Date.now() + 61_000))
  await submit(page).click()
  await expect(page.locator('#status')).toContainText('expired or was released')
  expect(await calls(page, 'putTextLocked')).toHaveLength(0)
  await page.evaluate((path) => {
    globalThis.__pubkyTest.files[path].json = {
      title: 'Changed remotely',
      body: 'New remote contents',
      updatedAt: '2026-02-01T00:00:00.000Z',
    }
  }, notePath)
  await page.getByRole('button', { name: 'Lock & edit', exact: true }).click()
  await expect(page.locator('#status')).toContainText('The file changed since you started editing')
  await expect(page.locator('textarea[name="body"]')).toHaveValue('My unsaved work')
  await expect(submit(page)).toBeDisabled()
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('button', { name: 'Lock & edit', exact: true }).click()
  await expect(page.locator('textarea[name="body"]')).toHaveValue('New remote contents')
  await expect(submit(page)).toBeEnabled()
  expect(await calls(page, 'putTextLocked')).toHaveLength(0)
})

test('a lost lock during renewal preserves the draft and blocks a stale write', async ({
  page,
}) => {
  await openApp(page, { files: { [notePath]: note } })
  await page.getByRole('button', { name: 'Lock & edit', exact: true }).click()
  await page.locator('textarea[name="body"]').fill('Keep this after lock loss')
  await failNext(page, 'refreshLock', { message: 'Precondition failed', statusCode: 412 })
  await page.getByRole('button', { name: 'Renew lock', exact: true }).click()
  await expect(page.locator('#status')).toContainText('The file lock was lost')
  await expect(page.locator('textarea[name="body"]')).toHaveValue('Keep this after lock loss')
  await submit(page).click()
  await expect(page.locator('#status')).toContainText('expired or was released')
  expect(await calls(page, 'putTextLocked')).toHaveLength(0)
  await page.getByRole('button', { name: 'Lock & edit', exact: true }).click()
  await expect(page.locator('textarea[name="body"]')).toHaveValue('Keep this after lock loss')
  await submit(page).click()
  await expect(page.locator('#status')).toContainText('File saved:')
  expect(await calls(page, 'putTextLocked')).toHaveLength(1)
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

for (const problem of ['malformed JSON', 'getJson', 'stats']) {
  test(`a displayed note can be deleted despite ${problem}`, async ({ page }) => {
    await openApp(page, { files: { [notePath]: note } })
    if (problem === 'malformed JSON') {
      await page.evaluate((path) => {
        globalThis.__pubkyTest.files[path].json = 'No longer a note'
      }, notePath)
    } else {
      await failNext(page, `${problem}:${notePath}`)
    }
    await page.evaluate(() => {
      globalThis.__pubkyTest.calls = []
    })
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.locator('#status')).toContainText('File deleted:')
    await expect(page.locator('#files-list li')).toHaveCount(0)
    expect(await calls(page, 'getJson')).toHaveLength(0)
    expect(await calls(page, 'stats')).toHaveLength(0)
    expect(
      (await page.evaluate(() => globalThis.__pubkyTest.calls.map((call) => call.method))).slice(
        0,
        3,
      ),
    ).toEqual(['lock', 'deleteLocked', 'unlock'])
  })
}

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

for (const name of ['café.json', '100%25.txt']) {
  test(`the public reader preserves the SDK resource address for ${name}`, async ({ page }) => {
    await page.goto('/public-reader.html')
    const address = `pubky://${owner}/pub/example/${name}`
    await page.getByLabel('Pubky file address').fill(address)
    await page.getByRole('button', { name: 'Read public file', exact: true }).click()
    await expect(page.locator('.file-preview')).toHaveText('A public file')
    expect((await calls(page, 'public.stats')).map((call) => call.path)).toEqual([address])
    expect((await calls(page, 'public.get')).map((call) => call.path)).toEqual([address])
  })
}

test('event history, live restart, storage switching, and signout keep the correct subscription', async ({
  page,
}) => {
  await openApp(page)
  await page.evaluate(() => {
    globalThis.__pubkyTest.events = [
      { cursor: '1', path: '/pub/template/files/old.json' },
      { cursor: '2', path: '/pub/template/files/new.json' },
      { cursor: 'p1', path: '/priv/template/files/private.json' },
    ]
  })
  await page.getByRole('button', { name: 'Recent history', exact: true }).click()
  await expect(page.locator('#status')).toContainText('Loaded 2 recent events')
  await expect(page.locator('#event-list li')).toHaveCount(2)
  await expect(page.locator('#event-list li').first()).toContainText('new.json')
  expect(await page.evaluate(() => globalThis.__pubkyTest.subscriptions[0].options)).toEqual({
    path: '/pub/template/',
    maxEventBytes: 8192,
    reverse: true,
    limit: 12,
  })
  await page.getByRole('button', { name: 'Start live', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop live', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => globalThis.__pubkyTest.subscriptions.at(-1).cursor)).toBe('2')
  await page.evaluate(() =>
    globalThis.__pubkyTest.emitEvent({ cursor: '3', path: '/pub/template/files/live.json' }),
  )
  await expect(page.locator('#event-list li').first()).toContainText('live.json')
  await page.getByRole('button', { name: 'Stop live', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start live', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => globalThis.__pubkyTest.subscriptions.at(-1).canceled)).toBe(true)
  await page.getByRole('button', { name: 'Start live', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop live', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => globalThis.__pubkyTest.subscriptions.at(-1).cursor)).toBe('3')
  await page.getByRole('button', { name: 'Private storage', exact: true }).click()
  await expect(page.locator('#event-list')).toContainText('private.json')
  await expect(page.locator('#event-list')).not.toContainText('live.json')
  await expect
    .poll(() =>
      page.evaluate(() =>
        globalThis.__pubkyTest.subscriptions
          .filter((sub) => sub.options.live && !sub.canceled)
          .map((sub) => ({
            cursor: sub.cursor,
            path: sub.options.path,
            session: sub.options.session,
          })),
      ),
    )
    .toEqual([{ cursor: 'p1', path: '/priv/template/', session: true }])
  await page.evaluate(() =>
    globalThis.__pubkyTest.emitEvent({
      cursor: 'p2',
      path: '/priv/template/files/private-live.json',
    }),
  )
  await expect(page.locator('#event-list li').first()).toContainText('private-live.json')
  await page.locator('#sign-out').click()
  await expect(page.locator('#authorize-ring')).toBeVisible()
  await expect(page.locator('#event-list')).toHaveCount(0)
  expect(
    await page.evaluate(() =>
      globalThis.__pubkyTest.subscriptions.filter((sub) => sub.options.live && !sub.canceled),
    ),
  ).toHaveLength(0)
})

for (const historyFails of [false, true]) {
  test(`${historyFails ? 'failed' : 'empty'} event history clears live events and restores the start control`, async ({
    page,
  }) => {
    await openApp(page)
    await page.getByRole('button', { name: 'Start live', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => globalThis.__pubkyTest.subscriptions.at(-1)?.options.live))
      .toBe(true)
    await page.evaluate(() =>
      globalThis.__pubkyTest.emitEvent({ cursor: '1', path: '/pub/template/files/live.json' }),
    )
    await expect(page.locator('#event-list li')).toContainText('live.json')
    await expect(page.getByRole('button', { name: 'Stop live', exact: true })).toBeEnabled()

    if (historyFails) await failNext(page, 'events.subscribe')
    await page.getByRole('button', { name: 'Recent history', exact: true }).click()
    await expect(page.locator('#status')).toContainText(
      historyFails ? 'Simulated unavailable service' : 'Loaded 0 recent events',
    )
    await expect(page.locator('#event-list li')).toHaveCount(0)
    await expect(page.locator('#event-list')).toHaveText('No events yet.')
    await expect(page.getByRole('button', { name: 'Start live', exact: true })).toBeEnabled()
    expect(
      await page.evaluate(() =>
        globalThis.__pubkyTest.subscriptions.filter((sub) => sub.options.live && !sub.canceled),
      ),
    ).toHaveLength(0)

    if (historyFails) {
      await page.getByRole('button', { name: 'Recent history', exact: true }).click()
      await expect(page.locator('#status')).toContainText('Loaded 0 recent events')
    }
    await page.getByRole('button', { name: 'Start live', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop live', exact: true })).toBeEnabled()
    await expect
      .poll(() =>
        page.evaluate(() =>
          globalThis.__pubkyTest.subscriptions.some((sub) => sub.options.live && !sub.canceled),
        ),
      )
      .toBe(true)
    await page.evaluate(() =>
      globalThis.__pubkyTest.emitEvent({ cursor: '2', path: '/pub/template/files/restarted.json' }),
    )
    await expect(page.locator('#event-list li')).toContainText('restarted.json')
  })
}

test('event subscription and invalid event errors restore controls and allow retry', async ({
  page,
}) => {
  await openApp(page)
  await failNext(page, 'events.subscribe')
  await page.getByRole('button', { name: 'Recent history', exact: true }).click()
  await expect(page.locator('#status')).toContainText('Simulated unavailable service')
  await expect(page.getByRole('button', { name: 'Recent history', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Start live', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => globalThis.__pubkyTest.subscriptions.at(-1)?.options.live))
    .toBe(true)
  await page.evaluate(() =>
    globalThis.__pubkyTest.emitEvent({ cursor: 'bad', path: '/pub/someone-else/file.json' }),
  )
  await expect(page.locator('#status')).toContainText('outside the selected folder')
  await expect(page.getByRole('button', { name: 'Start live', exact: true })).toBeEnabled()
  await expect(page.locator('#event-list')).not.toContainText('someone-else')
  expect(await page.evaluate(() => globalThis.__pubkyTest.subscriptions.at(-1).canceled)).toBe(true)
  await page.getByRole('button', { name: 'Recent history', exact: true }).click()
  await expect(page.locator('#status')).toContainText('Loaded 0 recent events')
  await fillNote(page)
  await submit(page).click()
  await expect(page.locator('#status')).toContainText('File saved:')
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
