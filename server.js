import { createServer } from 'node:http'
import process from 'node:process'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import sirv from 'sirv'

const previewDirectories = new Set([
  '/basic-pubky-app',
  '/mainnet/basic-pubky-app',
  '/testnet/basic-pubky-app',
  '/vite-starter',
])

export function createSiteServer(directory = fileURLToPath(new URL('./dist/', import.meta.url))) {
  const serve = sirv(directory, { etag: true, maxAge: 0 })

  return createServer((request, response) => {
    const target = request.url || '/'
    const [pathname] = target.split('?')
    if (previewDirectories.has(pathname)) {
      response.writeHead(308, { Location: `${pathname}/${target.slice(pathname.length)}` })
      response.end()
      return
    }

    serve(request, response)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createSiteServer().listen(Number(process.env.PORT || 8080), '0.0.0.0')
}
