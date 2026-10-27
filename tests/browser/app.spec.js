import { test, expect } from './browser-test.js'
import { Buffer } from 'node:buffer'

const owner = '8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo'
const publicAddress = `pubky://${owner}/pub/example/file.txt`
const notePath = '/pub/template/files/existing.json'
const uploadPath = '/pub/template/attachments/example.bin'
const note = {
  json: { title: 'Existing note', body: 'Saved body', updatedAt: '2026-01-01T00:00:00.000Z' },
}
const upload = { bytes: [0, 128, 255], metadata: { contentLength: 3 } }

async function openApp(
  page,
  {
    signedIn = true,
    files = {},
    directories = [],
    failures = {},
    persistentFailures = {},
    capabilities,
  } = {},
) {
  await page.addInitScript(
    ({ signedIn, files, directories, failures, persistentFailures, capabilities }) => {
      globalThis.__pubkySeed = { files, directories, failures, persistentFailures, capabilities }
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
    { signedIn, files, directories, failures, persistentFailures, capabilities },
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

for (const kind of ['note', 'upload']) {
  test(`cold loading a ${kind} with unavailable metadata keeps both file types usable`, async ({
    page,
  }) => {
    await openApp(page, {
      files: { [notePath]: note, [uploadPath]: upload },
      failures: { [`stats:${kind === 'note' ? notePath : uploadPath}`]: 'Metadata unavailable' },
    })
    const noteRow = page.locator('#files-list li').filter({ hasText: 'Existing note' })
    const uploadRow = page.locator('#files-list li').filter({ hasText: 'example.bin' })
    await expect(noteRow).toBeVisible()
    await expect(uploadRow).toBeVisible()
    await expect(kind === 'note' ? noteRow : uploadRow).toContainText('Metadata unavailable.')
    await expect(kind === 'note' ? uploadRow : noteRow).not.toContainText('Metadata unavailable.')
    await expect(noteRow.getByRole('button', { name: 'Lock & edit', exact: true })).toBeEnabled()
    await expect(uploadRow.getByRole('button', { name: 'Download', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Private storage', exact: true }).click()
    await page.getByRole('button', { name: 'Public storage', exact: true }).click()
    await expect(page.locator('#files-list li')).toHaveCount(2)
    await expect(page.locator('#files-list')).not.toContainText('Metadata unavailable.')
  })
}

test('a persistent metadata failure still downloads the exact uploaded bytes', async ({ page }) => {
  await openApp(page, {
    files: { [uploadPath]: upload },
    persistentFailures: { [`stats:${uploadPath}`]: 'Metadata unavailable' },
  })
  const uploadRow = page.locator('#files-list li').filter({ hasText: 'example.bin' })
  await expect(uploadRow).toContainText('Metadata unavailable.')
  const completed = page.waitForEvent('download')
  await uploadRow.getByRole('button', { name: 'Download', exact: true }).click()
  const download = await completed
  expect(download.suggestedFilename()).toBe('example.bin')
  const stream = await download.createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  expect([...Buffer.concat(chunks)]).toEqual(upload.bytes)
  expect(await calls(page, 'get')).toEqual([{ method: 'get', path: uploadPath }])
  expect(await calls(page, 'stats')).toEqual([
    { method: 'stats', path: uploadPath },
    { method: 'stats', path: uploadPath },
  ])
})

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

test('failed approval validation and revocation can recover on the current page', async ({
  page,
}) => {
  await openApp(page, { signedIn: false })
  await failNext(page, 'sessions.restore', 'Approval validation unavailable')
  await failNext(page, 'signout', 'Revocation temporarily unavailable')
  await page.evaluate(() => globalThis.__pubkyTest.approveSignIn('failed-approval'))
  await expect(page.locator('#status')).toContainText('Revocation temporarily unavailable')
  await expect(page.locator('#retry-saved-session')).toBeEnabled()
  await expect(page.locator('#authorize-ring, #file-form')).toHaveCount(0)
  expect(await calls(page, 'startGrantAuthFlow')).toHaveLength(1)
  await page.evaluate(() =>
    globalThis.localStorage.setItem('test-sdk-recovered-logout:failed-approval', 'true'),
  )
  await page.locator('#retry-saved-session').click()
  await expect(page.locator('#authorize-ring')).toBeVisible()
  await expect(page.locator('#refresh-ring-signin')).toBeEnabled()
  expect(await calls(page, 'startGrantAuthFlow')).toHaveLength(2)
  expect(await page.evaluate(() => globalThis.localStorage.getItem('template:session'))).toBeNull()
  expect(
    await page.evaluate(() => JSON.parse(globalThis.localStorage.getItem('test-sdk-records'))),
  ).toEqual([])
})

for (const recordWasSaved of [false, true]) {
  test(`${recordWasSaved ? 'a deleted' : 'a missing'} SDK record cannot restore a selected session`, async ({
    page,
  }) => {
    await openApp(page, { signedIn: recordWasSaved })
    await page.evaluate(() => {
      globalThis.localStorage.setItem('template:session', 'browser-test:template')
      globalThis.localStorage.setItem('test-sdk-records', '[]')
    })
    await page.reload()
    await expect(page.locator('#authorize-ring')).toBeVisible()
    await expect(page.locator('#file-form, #retry-saved-session')).toHaveCount(0)
    expect(await calls(page, 'sessions.restore')).toEqual([
      { method: 'sessions.restore', path: 'browser-test:template' },
    ])
    expect(
      await page.evaluate(() => globalThis.localStorage.getItem('template:session')),
    ).toBeNull()
  })
}

test('another tab must finish a pending SDK revocation before restoring its record', async ({
  page,
}) => {
  await openApp(page)
  await failNext(page, 'signout', 'Revocation temporarily unavailable')
  await page.locator('#sign-out').click()
  await expect(page.getByRole('button', { name: 'Retry sign out', exact: true })).toBeEnabled()
  const otherPage = await page.context().newPage()
  await otherPage.goto('/')
  await expect(otherPage.locator('#retry-saved-session')).toBeEnabled()
  await expect(otherPage.locator('#authorize-ring, #file-form')).toHaveCount(0)
  expect(await calls(otherPage, 'startGrantAuthFlow')).toHaveLength(0)
  await otherPage.evaluate(() =>
    globalThis.localStorage.setItem('test-sdk-recovered-logout:browser-test:template', 'true'),
  )
  await otherPage.locator('#retry-saved-session').click()
  await expect(otherPage.locator('#authorize-ring')).toBeVisible()
  await expect(page.locator('#authorize-ring')).toBeVisible()
  expect(
    await page.evaluate(() => JSON.parse(globalThis.localStorage.getItem('test-sdk-records'))),
  ).toEqual([])
})

for (const failCleanup of [false, true]) {
  test(`a superseded grant ${failCleanup ? 'keeps failed revocation durable across reload' : "is revoked without replacing another tab's selected grant"}`, async ({
    page,
  }) => {
    await openApp(page, { signedIn: false })
    await page.evaluate(() => {
      globalThis.__pubkyTest.holdSaves = true
      globalThis.__pubkyTest.approveSignIn('stale-grant')
    })
    await expect.poll(() => page.evaluate(() => globalThis.__pubkyTest.pendingSaves.length)).toBe(1)
    const otherPage = await page.context().newPage()
    await otherPage.goto('/')
    await expect(otherPage.locator('#authorize-ring')).toBeVisible()
    await expect
      .poll(() => otherPage.evaluate(() => typeof globalThis.__pubkyTest.approveSignIn))
      .toBe('function')
    await otherPage.evaluate(() => globalThis.__pubkyTest.approveSignIn('selected-grant'))
    await expect(otherPage.locator('#sign-out')).toBeEnabled()
    if (failCleanup)
      await failNext(page, 'signout:stale-grant', 'Revocation temporarily unavailable')
    await page.evaluate(() => {
      globalThis.__pubkyTest.holdSaves = false
      globalThis.__pubkyTest.pendingSaves.forEach((resolve) => resolve())
    })
    await expect
      .poll(() => calls(page, 'signout'))
      .toContainEqual({ method: 'signout', path: 'stale-grant' })
    expect(await page.evaluate(() => globalThis.localStorage.getItem('template:session'))).toBe(
      'selected-grant',
    )
    if (failCleanup) {
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.keys(globalThis.localStorage).filter((key) =>
              key.includes('pending-revocation'),
            ),
          ),
        )
        .toHaveLength(1)
      await page.reload()
      await expect(page.locator('#retry-saved-session')).toBeEnabled()
      await expect(page.locator('#authorize-ring, #file-form')).toHaveCount(0)
      expect(await page.evaluate(() => globalThis.localStorage.getItem('template:session'))).toBe(
        'selected-grant',
      )
      await page.evaluate(() =>
        globalThis.localStorage.setItem('test-sdk-recovered-logout:stale-grant', 'true'),
      )
      await page.locator('#retry-saved-session').click()
    }
    await expect(page.locator('#sign-out')).toBeEnabled()
    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(globalThis.localStorage.getItem('test-sdk-records'))),
      )
      .toEqual(['selected-grant'])
    expect(
      await page.evaluate(() =>
        Object.keys(globalThis.localStorage).filter((key) => key.includes('pending-revocation')),
      ),
    ).toEqual([])
    expect(await page.evaluate(() => globalThis.localStorage.getItem('template:session'))).toBe(
      'selected-grant',
    )
  })
}

test('failed signout retains the session and must be retried before signing in again', async ({
  page,
}) => {
  await openApp(page)
  await page.evaluate(() => {
    globalThis.__observedSessionChanges = []
    globalThis.addEventListener('pubky-session-changed', (event) =>
      globalThis.__observedSessionChanges.push(event.detail),
    )
  })
  await failNext(page, 'signout')
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.locator('#status')).toContainText('Simulated unavailable service')
  await expect(page.getByRole('button', { name: 'Retry sign out', exact: true })).toBeEnabled()
  await expect(page.locator('#authorize-ring, #saved-accounts, #add-account')).toHaveCount(0)
  await expect(page.locator('#file-form')).toHaveCount(0)
  expect(await page.evaluate(() => globalThis.localStorage.getItem('template:session'))).toBe(
    'browser-test:template',
  )
  expect(await page.evaluate(() => globalThis.__observedSessionChanges)).toEqual([])
  await page.getByRole('button', { name: 'Retry sign out', exact: true }).click()
  await expect(page.locator('#authorize-ring')).toBeVisible()
  await expect(page.locator('#status')).toHaveText('Signed out.')
  await expect(page.locator('#file-form')).toHaveCount(0)
  expect(await page.evaluate(() => globalThis.localStorage.getItem('template:session'))).toBeNull()
  expect(await calls(page, 'signout')).toHaveLength(2)
  expect(await page.evaluate(() => globalThis.__observedSessionChanges)).toEqual([
    { id: 'browser-test:template', action: 'removed' },
  ])
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
  await page.evaluate(() => {
    globalThis.__observedSessionChanges = []
    globalThis.addEventListener('pubky-session-changed', (event) =>
      globalThis.__observedSessionChanges.push(event.detail),
    )
  })
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
  expect(await page.evaluate(() => globalThis.__observedSessionChanges)).toEqual([])
  await page.evaluate(() =>
    globalThis.localStorage.setItem('test-sdk-recovered-logout:browser-test:template', 'true'),
  )
  await page.locator('#retry-saved-session').click()
  await expect(page.locator('#authorize-ring')).toBeEnabled()
  await expect(page.locator('#refresh-ring-signin')).toBeEnabled()
  await expect(page.locator('#status')).toHaveText('This session was signed out or removed.')
  await expect(page.locator('#retry-saved-session, #file-form')).toHaveCount(0)
  expect(await page.evaluate(() => globalThis.localStorage.getItem('template:session'))).toBeNull()
  expect(await page.evaluate(() => globalThis.__observedSessionChanges)).toEqual([
    { id: 'browser-test:template', action: 'removed' },
  ])
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
  await expect(page.locator('#status')).toHaveText('Signed out.')
  await expect(otherPage.locator('#authorize-ring')).toBeVisible()
  await expect(otherPage.locator('#status')).toContainText('another tab.')
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
    if (failure === 'stats') {
      await expect(page.locator('#files-list')).toContainText('Metadata unavailable.')
      await expect(page.locator('#status')).not.toContainText(/refresh/i)
    } else {
      await expect(page.locator('#status')).toContainText(/refresh/i)
    }
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
    const input = page.locator('#file-form input[type="file"]')
    await input.setInputFiles({
      name: 'upload.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([0, 128, 255]),
    })
    await failNext(page, failWrite ? 'putBlob' : 'list:/pub/template/attachments/')
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
    expect(await calls(page, 'putBlob')).toHaveLength(failWrite ? 2 : 1)
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

for (const cached of [true, false]) {
  test(`the public reader can read again after ${cached ? 'persisted page transitions' : 'a reload'}`, async ({
    page,
  }) => {
    await page.goto('/public-reader.html')
    await page.getByLabel('Pubky file address').fill(publicAddress)
    await page.getByRole('button', { name: 'Read public file', exact: true }).click()
    await expect(page.locator('.file-preview')).toHaveText('A public file')
    if (cached) {
      // Exercise lifecycle handling independently of Chromium's cache admission.
      await page.evaluate(() => {
        globalThis.window.dispatchEvent(
          new globalThis.PageTransitionEvent('pagehide', { persisted: true }),
        )
        globalThis.window.dispatchEvent(
          new globalThis.PageTransitionEvent('pageshow', { persisted: true }),
        )
      })
      await expect(page.locator('.file-preview')).toHaveText('A public file')
      await expect(page.getByLabel('Pubky file address')).toHaveValue(publicAddress)
    } else {
      await page.reload()
      await expect(page.locator('.file-preview')).toHaveCount(0)
      await page.getByLabel('Pubky file address').fill(publicAddress)
    }
    await page.evaluate(() => {
      globalThis.__pubkyTest.publicFile.body = 'A later public file'
    })
    await page.getByRole('button', { name: 'Read public file', exact: true }).click()
    await expect(page.locator('.file-preview')).toHaveText('A later public file')
    await expect(page.locator('#storage-tools-status')).toHaveText(
      'Public file loaded without authentication.',
    )
    expect(await calls(page, 'sessions.restore')).toHaveLength(0)
    expect(await calls(page, 'sessions.list')).toHaveLength(0)
  })
}

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

async function downloadedBytes(download) {
  const chunks = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk)
  return Buffer.concat(chunks)
}

for (const space of ['public', 'private']) {
  test(`${space} encrypted uploads decrypt normally and recover a ciphertext download locally`, async ({
    page,
  }) => {
    await openApp(page)
    await page
      .getByRole('button', {
        name: `${space === 'public' ? 'Public' : 'Private'} storage`,
        exact: true,
      })
      .click()
    await page.getByLabel('Choose a file', { exact: true }).check()
    const plaintext = Buffer.from([0, 128, 255, 10])
    await page.locator('#file-form input[type="file"]').setInputFiles({
      name: `${space}.bin`,
      mimeType: 'application/octet-stream',
      buffer: plaintext,
    })
    const checkbox = page.getByLabel('Encrypt this upload')
    const label = page.locator('#file-form .checkbox-field span')
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 })
      const box = await checkbox.boundingBox()
      const text = await label.boundingBox()
      expect(box.width).toBeLessThan(24)
      expect(Math.abs(box.y + box.height / 2 - text.y - text.height / 2)).toBeLessThan(2)
      expect(box.x + box.width).toBeLessThan(text.x)
    }
    await checkbox.check()
    await submit(page).click()
    await expect(page.locator('#status')).toContainText('File uploaded:')
    const row = page.locator('#files-list li').filter({ hasText: `${space}.bin.pubkyenc` })
    await expect(row).toContainText('Encrypted file')
    const writes = await calls(page, 'putBytes')
    expect(writes).toHaveLength(1)
    expect(await calls(page, 'putBlob')).toHaveLength(0)
    const encrypted = await page.evaluate(
      (path) => globalThis.__pubkyTest.files[path].bytes,
      writes[0].path,
    )
    expect(encrypted).toHaveLength(plaintext.length + 36)
    expect(encrypted).not.toEqual([...plaintext])

    const normalDownload = page.waitForEvent('download')
    await row.getByRole('button', { name: 'Decrypt & download', exact: true }).click()
    expect(await downloadedBytes(await normalDownload)).toEqual(plaintext)

    const rawDownload = page.waitForEvent('download')
    await row.getByRole('button', { name: 'Download ciphertext', exact: true }).click()
    const ciphertext = await rawDownload
    const raw = await downloadedBytes(ciphertext)
    expect([...raw]).toEqual(encrypted)
    await expect(page.locator('#status')).toContainText('File downloaded.')
    await page.getByRole('link', { name: 'Tools', exact: true }).click()
    await expect(page.locator('#encryption-recovery')).toBeVisible()
    await page.getByLabel('Original storage').selectOption(space)
    const before = await page.evaluate(() => globalThis.__pubkyTest.calls.length)
    await page.locator('#encryption-recovery input').setInputFiles({
      name: ciphertext.suggestedFilename(),
      mimeType: 'application/octet-stream',
      buffer: raw,
    })
    const recoveredDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Decrypt with saved keys', exact: true }).click()
    expect(await downloadedBytes(await recoveredDownload)).toEqual(plaintext)
    await expect(page.locator('#encryption-recovery [role="status"]')).toContainText(
      'Decrypted locally',
    )
    expect(
      await page.evaluate((before) => globalThis.__pubkyTest.calls.slice(before), before),
    ).toEqual([{ method: 'sessions.restoreEncryptionKeys', path: 'browser-test:template' }])
  })
}

for (const space of ['public', 'private']) {
  test(`declining ${space} encryption retains the upload and allows an explicit unencrypted upload`, async ({
    page,
  }) => {
    await openApp(page)
    await page.evaluate(() => (globalThis.__pubkyTest.declineEncryption = true))
    await page
      .getByRole('button', {
        name: `${space === 'public' ? 'Public' : 'Private'} storage`,
        exact: true,
      })
      .click()
    await page.getByLabel('Choose a file', { exact: true }).check()
    const input = page.locator('#file-form input[type="file"]')
    await input.setInputFiles({
      name: 'file.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('private'),
    })
    await page.getByLabel('Encrypt this upload').check()
    await submit(page).click()
    await expect(page.locator('#status')).toContainText('No encryption keys were approved')
    expect(await calls(page, 'putBytes')).toHaveLength(0)
    expect(await calls(page, 'putBlob')).toHaveLength(0)
    expect(await input.evaluate((input) => input.files.length)).toBe(1)
    await page.getByLabel('Encrypt this upload').uncheck()
    await submit(page).click()
    await expect(page.locator('#status')).toContainText('File uploaded:')
    expect(await calls(page, 'putBlob')).toHaveLength(1)
  })
}

test('read-only private approval loads files and history while disabling mutations', async ({
  page,
}) => {
  await openApp(page, {
    capabilities: ['/priv/template/:r'],
    files: { '/priv/template/attachments/readable.bin': upload },
  })
  await expect(page.getByRole('button', { name: 'Private storage', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByText('Read-only access to this folder.', { exact: false })).toBeVisible()
  const row = page.locator('#files-list li')
  await expect(row.getByRole('button', { name: 'Download', exact: true })).toBeEnabled()
  await expect(row.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
  await expect(submit(page)).toBeDisabled()
  await page.getByRole('button', { name: 'Recent history', exact: true }).click()
  await expect(page.locator('#status')).toContainText('Loaded 0 recent events')
  await page.getByRole('link', { name: 'Tools', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sign and verify', exact: true })).toBeEnabled()
})

test('cross-tab invalidation during key derivation prevents the encrypted write', async ({
  page,
}) => {
  await openApp(page)
  await page.evaluate(() => (globalThis.__pubkyTest.holdDerivations = true))
  await page.getByRole('button', { name: 'Private storage', exact: true }).click()
  await page.getByLabel('Choose a file', { exact: true }).check()
  await page.locator('#file-form input[type="file"]').setInputFiles({
    name: 'private.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('secret'),
  })
  await page.getByLabel('Encrypt this upload').check()
  await submit(page).click()
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.__pubkyTest.releaseDerivation))
    .toBe('function')
  await page.evaluate(() => {
    globalThis.localStorage.removeItem('template:session')
    globalThis.dispatchEvent(
      new globalThis.StorageEvent('storage', {
        key: 'template:session',
        storageArea: globalThis.localStorage,
      }),
    )
    globalThis.__pubkyTest.holdDerivations = false
    globalThis.__pubkyTest.releaseDerivation()
  })
  await expect(page.locator('#authorize-ring')).toBeVisible()
  expect(await calls(page, 'putBytes')).toHaveLength(0)
  await expect(page.locator('#encryption-recovery')).toHaveCount(0)
  await expect(page.locator('#proof-tools')).toHaveCount(0)
})
