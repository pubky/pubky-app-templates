type Page = 'files' | 'reader' | 'tools'

export function pageNavigationHtml(current: Page) {
  const pages: Array<{ page: Page; href: string; label: string }> = [
    { page: 'files', href: './', label: 'Your files' },
    { page: 'reader', href: './public-reader.html', label: 'Public file reader' },
    { page: 'tools', href: './tools.html', label: 'Tools' },
  ]
  return `<nav class="page-nav" aria-label="Pages">${pages
    .map(({ page, href, label }) =>
      page === current
        ? `<strong aria-current="page">${label}</strong>`
        : `<a href="${href}">${label}</a>`,
    )
    .join(' · ')}</nav>`
}
