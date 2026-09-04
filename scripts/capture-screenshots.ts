/**
 * Captures the screenshots used by the README and the docs, from a locally running
 * instance. Every image it writes is referenced somewhere; if you add one here, use
 * it, and if you stop using one, drop it from this list.
 *
 *   pnpm dev            # in one terminal
 *   pnpm demo:seed      # once, to fill the charts
 *   pnpm screenshots
 *
 * Signs in as the demo account, then walks it twice: once in light and once in dark,
 * writing `name.webp` and `name-dark.webp`. The docs pair them in a <picture> so
 * GitHub shows whichever matches the reader's theme. The app resolves its own theme
 * from prefers-color-scheme when nobody has chosen one, so emulating the media query
 * is enough.
 *
 * Output is lossless WebP. Playwright only encodes PNG, so each capture is converted
 * and the PNG discarded. Lossless keeps the text crisp at 2x and still lands around
 * 70% smaller than the PNG; for flat UI colour it is no larger than lossy q80.
 */
import { chromium } from 'playwright-core'
import { execFile } from 'node:child_process'
import { mkdir, rm, readdir, stat } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

const ORIGIN = process.env.FLAREMENDER_URL ?? 'http://localhost:3009'
const EMAIL = process.env.DEMO_EMAIL ?? 'ada@example.com'
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123'
const OUT = 'docs/screenshots'

const VIEWPORT = { width: 1440, height: 900 }
const SCALE = 2

/** cwebp is the reference encoder; ImageMagick produces a byte-identical result. */
const ENCODERS = [
  {
    bin: 'cwebp',
    args: (from: string, to: string) => [
      '-quiet',
      '-lossless',
      '-z',
      '9',
      '-m',
      '6',
      '-metadata',
      'none',
      from,
      '-o',
      to,
    ],
  },
  {
    bin: 'magick',
    args: (from: string, to: string) => [
      from,
      '-define',
      'webp:lossless=true',
      '-define',
      'webp:method=6',
      '-strip',
      to,
    ],
  },
]

async function pickEncoder(): Promise<(typeof ENCODERS)[number] | null> {
  for (const encoder of ENCODERS) {
    try {
      await run(encoder.bin, ['-version'])
      return encoder
    } catch {
      // Not installed; try the next one.
    }
  }
  return null
}

async function main() {
  await mkdir(OUT, { recursive: true })

  const encoder = await pickEncoder()
  if (encoder) {
    console.log(`Encoding with ${encoder.bin}`)
  } else {
    console.warn(
      'Neither cwebp nor magick is on PATH, so the screenshots stay as PNG.\n' +
        'Install one (brew install webp, or brew install imagemagick) and re-run.',
    )
  }

  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()

  // The dev-tools bubble is not part of the product.
  await page.addStyleTag({
    content: `
      [data-testid="tanstack_devtools"] { display: none !important; }
    `,
  })

  const shot = async (name: string, options: { fullPage?: boolean } = {}) => {
    // Charts animate in; give echarts a beat to settle before capturing.
    await page.waitForTimeout(1500)

    const png = `${OUT}/${name}.png`
    const webp = `${OUT}/${name}.webp`
    await page.screenshot({ path: png, fullPage: options.fullPage ?? false })

    if (!encoder) {
      console.log(`  ${name}.png (not converted)`)
      return
    }

    await rm(webp, { force: true })
    await run(encoder.bin, encoder.args(png, webp))
    const [before, after] = await Promise.all([stat(png), stat(webp)])
    await rm(png)
    console.log(
      `  ${name}.webp  ${Math.round(after.size / 1024)} KB` +
        ` (${Math.round((1 - after.size / before.size) * 100)}% smaller than PNG)`,
    )
  }

  const open = async (path: string) => {
    await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle' })
    await page.addStyleTag({
      content: `
        [data-testid="tanstack_devtools"] { display: none !important; }
      `,
    })
  }

  console.log('Signing in')
  await page.goto(`${ORIGIN}/signin`, { waitUntil: 'networkidle' })

  // The form is inert until React hydrates, and a click before then is swallowed
  // silently, so submit until the dashboard actually renders.
  const dashboard = page.getByRole('heading', { name: /Welcome back/ })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.waitForTimeout(1500)
    await page.getByLabel('Email').fill(EMAIL)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.locator('button[type=submit]').click()
    try {
      await dashboard.waitFor({ timeout: 8_000 })
      break
    } catch {
      if (attempt === 4) throw new Error('Could not sign in. Is the demo account seeded?')
    }
  }

  const storefront = '/projects/prj_demo_storefront'

  const walk = async (theme: 'light' | 'dark') => {
    const suffix = theme === 'dark' ? '-dark' : ''
    console.log(`\nCapturing ${theme}`)
    await page.emulateMedia({ colorScheme: theme })

    await open('/dashboard')
    await shot(`dashboard${suffix}`)

    for (const [path, name] of [
      [storefront, 'project-overview'],
      [`${storefront}?tab=chat`, 'project-chat'],
      [`${storefront}?tab=intents`, 'project-tests'],
    ] as const) {
      await open(path)
      await shot(`${name}${suffix}`)
    }

    // The failing test, so the evidence panels have something in them.
    await open(`${storefront}/intents/int_storefront_5`)
    await shot(`test-detail${suffix}`, { fullPage: true })

    // Environments, with the variable list open so the masked values show.
    await open(`${storefront}?tab=environments`)
    const variables = page.getByRole('button', { name: /Variables \(2\)/ }).first()
    if ((await variables.count()) > 0) {
      await variables.click()
      await page.waitForTimeout(500)
    }
    await shot(`project-environments${suffix}`)

    // Run history lives under the test's own Runs tab, as expandable rows.
    await open(`${storefront}/intents/int_storefront_5?tab=runs`)
    await shot(`test-runs${suffix}`)

    const expander = page.locator('tbody tr button, tbody tr [role="button"]').first()
    if ((await expander.count()) > 0) {
      await expander.click()
      await page.waitForTimeout(800)
    }

    const runLink = page.locator('a[href*="/runs/"]').first()
    if ((await runLink.count()) === 0) {
      throw new Error('No run linked from the failing test; is the demo data seeded?')
    }
    await open((await runLink.getAttribute('href'))!)
    await shot(`run-detail${suffix}`, { fullPage: true })
  }

  await walk('light')
  await walk('dark')

  await context.close()
  await browser.close()

  const files = await readdir(OUT)
  const sizes = await Promise.all(files.map((file) => stat(`${OUT}/${file}`)))
  const total = sizes.reduce((sum, entry) => sum + entry.size, 0)
  console.log(`\nWrote ${files.length} files to ${OUT}/ (${Math.round(total / 1024)} KB total)`)
}

await main()
