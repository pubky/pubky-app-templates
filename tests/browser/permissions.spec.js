import { Buffer } from 'node:buffer'
import { test, expect } from './browser-test.js'

const owner = '8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo'
const initialId = 'browser-test:template'
const storageCaps = ['/pub/template/:rw', '/priv/template/:rw']

async function openApp(page, { signedIn = true, capabilities = storageCaps } = {}) {
  await page.addInitScript(
    ({ signedIn, capabilities, initialId }) => {
      globalThis.__pubkySeed = { capabilities }
      if (globalThis.sessionStorage.getItem('test-initialized')) return
      globalThis.sessionStorage.setItem('test-initialized', 'true')
      if (signedIn) {
        globalThis.localStorage.setItem('template:session', initialId)
        globalThis.localStorage.setItem('test-sdk-records', JSON.stringify([initialId]))
      }
    },
    { signedIn, capabilities, initialId },
  )
  await page.goto('/')
  await expect(page.locator(signedIn ? '#sign-out' : '#authorize-ring')).toBeVisible()
  await expect(page.locator(signedIn ? '#sign-out' : '#refresh-ring-signin')).toBeEnabled()
}

async function selectEncryptedUpload(page, filename = 'café 100%.txt') {
  await page.getByLabel('Choose a file', { exact: true }).check()
  await page.locator('#file-form input[type="file"]').setInputFiles({
    name: filename,
    mimeType: 'text/plain',
    buffer: Buffer.from('A file encrypted after permission approval'),
  })
  await page.getByLabel('Encrypt this upload').check()
  await expect(page.locator('#authorize-encryption')).toBeVisible()
  await expect(page.locator('#file-form button[type="submit"]')).toBeDisabled()
}

async function beginEncryptionAuthorization(page) {
  await page.locator('#authorize-encryption').click()
  await expect(page.locator('#permission-auth-slot #authorize-ring')).toBeVisible()
  await expect(page.locator('#permission-auth-slot #authorize-ring')).toHaveAttribute(
    'href',
    /pubkyring:/,
  )
}

const selectedId = (page) =>
  page.evaluate(() => globalThis.localStorage.getItem('template:session'))
const requests = (page) => page.evaluate(() => globalThis.__pubkyTest.authRequests)

async function approve(page, id, approval = {}) {
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.__pubkyTest.approveSignIn))
    .toBe('function')
  await page.evaluate(({ id, approval }) => globalThis.__pubkyTest.approveSignIn(id, approval), {
    id,
    approval,
  })
}

async function downloadedBytes(download) {
  const stream = await download.createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

test('initial authorization requests only folder storage access and no chosen identity', async ({
  page,
}) => {
  await openApp(page, { signedIn: false })
  const [request] = await requests(page)
  expect(new Set(request.capabilities.split(','))).toEqual(new Set(storageCaps))
  expect(request.expectedSigner).toBeUndefined()
  expect(request.approvalFormat).toBe('signedApprovalV1')
  await approve(page, 'first-sign-in')
  await expect(page.locator('#file-form')).toBeVisible()
  expect(await selectedId(page)).toBe('first-sign-in')
  await selectEncryptedUpload(page)
  expect(await requests(page)).toHaveLength(1)
})

test('same-account encryption approval retains the selected file and supports special-name offline recovery', async ({
  page,
}) => {
  await openApp(page)
  await page.getByLabel('Title', { exact: true }).fill('Keep my note draft')
  await selectEncryptedUpload(page)
  await beginEncryptionAuthorization(page)
  const [request] = await requests(page)
  expect(request.expectedSigner).toBe(owner)
  expect(new Set(request.capabilities.split(','))).toEqual(
    new Set([...storageCaps, '/pub/template/attachments/:e']),
  )
  await approve(page, 'public-encryption')
  await expect(page.locator('#status')).toContainText('Permissions updated.')
  expect(await selectedId(page)).toBe('public-encryption')
  await expect(page.locator('#permission-auth-slot')).toBeEmpty()
  await expect(page.getByLabel('Encrypt this upload')).toBeChecked()
  expect(
    await page.locator('#file-form input[type="file"]').evaluate((input) => input.files[0].name),
  ).toBe('café 100%.txt')
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Keep my note draft')
  await expect(page.locator('#file-form button[type="submit"]')).toBeEnabled()
  await page.locator('#file-form button[type="submit"]').click()
  await expect(page.locator('#status')).toContainText('File uploaded:')
  const row = page.locator('#files-list li').filter({ hasText: 'café 100%.txt.pubkyenc' })
  await expect(row).toBeVisible()
  const originalStoredName = await row.locator('strong').innerText()
  const downloadEvent = page.waitForEvent('download')
  await row.getByRole('button', { name: 'Download ciphertext', exact: true }).click()
  const download = await downloadEvent
  expect(download.suggestedFilename()).toMatch(/café 100.*\.txt\.pubkyenc$/)
  const encrypted = await downloadedBytes(download)
  await page.getByRole('link', { name: 'Tools', exact: true }).click()
  await expect(page.locator('#encryption-recovery')).toBeVisible()
  await page.getByLabel('Original storage').selectOption('public')
  await page.locator('#encryption-recovery input[type="file"]').setInputFiles({
    name: download.suggestedFilename(),
    mimeType: 'application/octet-stream',
    buffer: encrypted,
  })
  await expect(page.getByLabel('Original stored filename')).toHaveValue(
    download.suggestedFilename(),
  )
  // Browsers can rename downloads; derive from the exact name stored on the Homeserver.
  await page.getByLabel('Original stored filename').fill(originalStoredName)
  const recoveryEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Decrypt with saved keys', exact: true }).click()
  const recovery = await recoveryEvent
  expect(recovery.suggestedFilename()).toMatch(/café 100.*\.txt$/)
  expect((await downloadedBytes(recovery)).toString()).toBe(
    'A file encrypted after permission approval',
  )
  await expect(page.locator('#encryption-recovery [role="status"]')).toContainText(
    'Decrypted locally',
  )
})

test('canceling permission authorization keeps the old session and ordinary upload available', async ({
  page,
}) => {
  await openApp(page)
  await selectEncryptedUpload(page)
  await beginEncryptionAuthorization(page)
  await page.locator('#cancel-permission-auth').click()
  await expect(page.locator('#permission-auth-slot')).toBeEmpty()
  expect(await selectedId(page)).toBe(initialId)
  expect(
    await page.evaluate(() => globalThis.sessionStorage.getItem('template:session:pending-auth')),
  ).toBeNull()
  await page.getByLabel('Encrypt this upload').uncheck()
  await page.locator('#file-form button[type="submit"]').click()
  await expect(page.locator('#status')).toContainText('File uploaded:')
  expect(
    await page.evaluate(() =>
      globalThis.__pubkyTest.calls.filter((call) => call.method === 'putBlob'),
    ),
  ).toHaveLength(1)
  expect(
    await page.evaluate(() =>
      globalThis.__pubkyTest.calls.filter((call) => call.method === 'putBytes'),
    ),
  ).toHaveLength(0)
})

test('pending encryption authorization keeps its folder and QR code when switching storage views', async ({
  page,
}) => {
  await openApp(page)
  await selectEncryptedUpload(page)
  await beginEncryptionAuthorization(page)
  const link = await page.locator('#authorize-ring').getAttribute('href')
  await page.getByRole('button', { name: 'Private storage', exact: true }).click()
  await expect(page.locator('#permission-auth-slot')).toContainText('/pub/template/attachments/')
  await expect(page.locator('#authorize-ring')).toHaveAttribute('href', link)
  await expect
    .poll(() =>
      page
        .locator('#ring-signin-qr')
        .evaluate((canvas) =>
          [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data].some(
            (value) => value !== 0,
          ),
        ),
    )
    .toBe(true)
  const [request] = await requests(page)
  expect(request.capabilities).toContain('/pub/template/attachments/:e')
  expect(request.capabilities).not.toContain('/priv/template/attachments/:e')
})

test('retrying previous grant cleanup keeps the new session and selected upload', async ({
  page,
}) => {
  await openApp(page)
  await selectEncryptedUpload(page)
  await beginEncryptionAuthorization(page)
  await page.evaluate((id) => {
    globalThis.__pubkyTest.failures[`signout:${id}`] = 'Temporary revocation failure'
  }, initialId)
  await approve(page, 'new-grant-pending-cleanup')
  await expect(page.locator('#status')).toContainText('Permissions updated.')
  await expect(page.locator('#previous-grant-cleanup')).toContainText('cleanup is pending')
  await page.evaluate((id) => {
    globalThis.localStorage.setItem(`test-sdk-recovered-logout:${id}`, 'true')
  }, initialId)
  await page.locator('#retry-permission-cleanup').click()
  await expect(page.locator('#previous-grant-cleanup')).toBeEmpty()
  expect(await selectedId(page)).toBe('new-grant-pending-cleanup')
  expect(
    await page.locator('#file-form input[type="file"]').evaluate((input) => input.files[0].name),
  ).toBe('café 100%.txt')
  await expect(page.locator('#file-form button[type="submit"]')).toBeEnabled()
})

test('declining encryption keys preserves the previous grant and never uploads plaintext implicitly', async ({
  page,
}) => {
  await openApp(page)
  await selectEncryptedUpload(page)
  await beginEncryptionAuthorization(page)
  await approve(page, 'declined-encryption', { capabilities: storageCaps })
  await expect(page.locator('#status')).toContainText('Encryption access was not approved')
  expect(await selectedId(page)).toBe(initialId)
  await expect(page.locator('#file-form button[type="submit"]')).toBeDisabled()
  expect(
    await page.locator('#file-form input[type="file"]').evaluate((input) => input.files.length),
  ).toBe(1)
  expect(
    await page.evaluate(() => JSON.parse(globalThis.localStorage.getItem('test-sdk-records'))),
  ).toEqual([initialId])
  expect(
    await page.evaluate(() =>
      globalThis.__pubkyTest.calls.filter((call) => ['putBlob', 'putBytes'].includes(call.method)),
    ),
  ).toEqual([])
})

test('a pending permission request resumes for the same identity after reload', async ({
  page,
}) => {
  await openApp(page)
  await selectEncryptedUpload(page)
  await beginEncryptionAuthorization(page)
  const [before] = await requests(page)
  await page.reload()
  await expect(page.locator('#permission-auth-slot #authorize-ring')).toHaveAttribute(
    'href',
    /pubkyring:/,
  )
  expect(await requests(page)).toEqual([])
  expect(await page.evaluate(() => globalThis.__pubkyTest.authResumptions)).toEqual([before])
  expect(await selectedId(page)).toBe(initialId)
  await approve(page, 'resumed-encryption')
  await expect(page.locator('#status')).toContainText('Permissions updated.')
  expect(await selectedId(page)).toBe('resumed-encryption')
})

test('sign-out cancels a pending permission approval even while remote revocation is delayed', async ({
  page,
}) => {
  await openApp(page)
  await selectEncryptedUpload(page)
  await beginEncryptionAuthorization(page)
  await page.evaluate((id) => {
    globalThis.__latePermissionApproval = globalThis.__pubkyTest.approveSignIn
    globalThis.__pubkyTest.holdSignoutId = id
  }, initialId)
  await page.locator('#sign-out').click()
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.__pubkyTest.releaseSignout))
    .toBe('function')
  await page.evaluate(() => globalThis.__latePermissionApproval('late-permission-grant'))
  await expect
    .poll(() =>
      page.evaluate(() =>
        globalThis.__pubkyTest.calls.some(
          (call) => call.method === 'signout' && call.path === 'late-permission-grant',
        ),
      ),
    )
    .toBe(true)
  expect(await selectedId(page)).toBe(initialId)
  await expect(page.locator('#file-form')).toHaveCount(0)
  await page.evaluate(() => globalThis.__pubkyTest.releaseSignout())
  await expect(page.locator('#authorize-ring')).toBeVisible()
  expect(await selectedId(page)).toBeNull()
  expect(
    await page.evaluate(() => JSON.parse(globalThis.localStorage.getItem('test-sdk-records'))),
  ).toEqual([])
})

test('account inspection requests root read explicitly and loads the granted account on demand', async ({
  page,
}) => {
  await openApp(page)
  await page.getByRole('link', { name: 'Tools', exact: true }).click()
  await expect(page.locator('#account-tools')).toContainText('every public and private folder')
  await expect(page.locator('#load-account')).toHaveCount(0)
  expect(await requests(page)).toEqual([])
  await page.locator('#authorize-account-permissions').click()
  await expect(page.locator('#permission-auth-slot #authorize-ring')).toHaveAttribute(
    'href',
    /pubkyring:/,
  )
  const [request] = await requests(page)
  expect(request.expectedSigner).toBe(owner)
  expect(new Set(request.capabilities.split(','))).toEqual(new Set([...storageCaps, '/:r']))
  await approve(page, 'account-inspection')
  await expect(page.locator('#load-account')).toBeVisible()
  expect(
    await page.evaluate(() =>
      globalThis.__pubkyTest.calls.filter((call) => call.method === 'grant.account'),
    ),
  ).toEqual([])
  await page.locator('#load-account').click()
  await expect(page.locator('#account-result')).toContainText('Storage used: 4,096 bytes')
  await expect(page.locator('#account-result')).toContainText('"storageQuotaMb": "unlimited"')
  await expect(page.locator('#account-status')).toContainText('Account information loaded.')
})

test('adding private encryption preserves public encryption keys and synchronizes the new grant across tabs', async ({
  page,
}) => {
  await openApp(page, { capabilities: [...storageCaps, '/pub/template/attachments/:e'] })
  const other = await page.context().newPage()
  await other.goto('/')
  await expect(other.locator('#sign-out')).toBeEnabled()
  await page.getByRole('button', { name: 'Private storage', exact: true }).click()
  await selectEncryptedUpload(page)
  await beginEncryptionAuthorization(page)
  const [request] = await requests(page)
  expect(new Set(request.capabilities.split(','))).toEqual(
    new Set([...storageCaps, '/pub/template/attachments/:e', '/priv/template/attachments/:e']),
  )
  await approve(page, 'both-spaces')
  await expect(page.locator('#status')).toContainText('Permissions updated.')
  await expect.poll(() => selectedId(other)).toBe('both-spaces')
  await other.getByText('Granted permissions', { exact: true }).click()
  await expect(other.locator('details')).toContainText('/pub/template/attachments/:e')
  await expect(other.locator('details')).toContainText('/priv/template/attachments/:e')
  await other.close()
})
