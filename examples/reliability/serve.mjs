import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const port = Number(process.argv[2] ?? 4175)
const html = await readFile(new URL('./index.html', import.meta.url))
createServer((request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`)
  if (url.pathname === '/unavailable') {
    response.writeHead(503, { 'Content-Type': 'text/plain' })
    response.end('Fixture service unavailable')
    return
  }
  const send = () => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(html) }
  if (url.pathname === '/delayed') setTimeout(send, 750)
  else send()
}).listen(port, '127.0.0.1', () => console.log(`Reliability lab: http://localhost:${port}`))
