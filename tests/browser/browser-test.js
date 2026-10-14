import { test as base, expect } from '@playwright/test'
import { URL } from 'node:url'

export { expect }

export const test = base.extend({
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
