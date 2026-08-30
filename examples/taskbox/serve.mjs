/** Tiny static server for the Taskbox demo app. `node serve.mjs [port]` */
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.argv[2] ?? 4173)

createServer(async (req, res) => {
  try {
    const html = await readFile(path.join(dir, 'index.html'))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  } catch {
    res.writeHead(500)
    res.end('taskbox: could not read index.html')
  }
}).listen(port, () => {
  console.log(`taskbox listening on http://localhost:${port}`)
})
