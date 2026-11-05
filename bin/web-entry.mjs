#!/usr/bin/env node
/**
 * Fixed-URL entrance for the DSH web UI.
 *
 * `dsh web` prints a URL with a fresh token on every start, so a phone bookmark
 * goes stale each restart. This helper starts `dsh web` as a child process and
 * answers on a fixed port in one of two modes:
 *
 *   proxy (default with a LAN address)
 *     A reverse proxy. DSH listens on loopback only (`--port` + 1), the URL stays
 *     on the entrance, and the entrance authenticates to DSH internally.
 *     Other devices must pair once with a passcode printed at start-up.
 *     The old `--port` keeps answering as a redirect to the entrance.
 *
 *   redirect (default on 127.0.0.1, loopback only)
 *     A 302 to the current token URL. DSH itself listens on `--port`.
 *
 * Usage:
 *   npx dsh-chat-ui                 # this PC only (redirect)
 *   npx dsh-chat-ui --host lan      # this machine's LAN IPv4, for phones (proxy + passcode)
 *   npx dsh-chat-ui --host 192.168.1.23
 *
 * Options:
 *   --host <ip|lan>     entrance address (default 127.0.0.1)
 *   --entry-port <n>    fixed entrance port (default 8123)
 *   --port <n>          proxy: legacy port kept as a redirect to the entrance;
 *                       redirect: the port dsh web listens on (default 8124)
 *   --upstream-port <n> proxy: where dsh web listens on loopback (default port+1)
 *   --mode <proxy|redirect>  override the mode (redirect is refused off loopback)
 *   --dsh-home <dir>    DSH_HOME to use (default: $DSH_HOME or ~/.dsh)
 *   --dsh-bin <file>    path to @deepseek-ai/dsh/lib/bin.js (auto-detected)
 *   --hostname <name>   stable name to advertise and accept (default: <computer-name>.local)
 *   --no-hostname       only advertise and accept the numeric address
 *   --reset-pairing     issue a new passcode and forget every paired device
 *   --quiet             only print errors
 *
 * Security (proxy mode):
 *   - Only requests whose Host is one of the entrance's own addresses are served
 *     (blocks DNS rebinding), and a cross-site Origin / Sec-Fetch-Site is refused
 *     (blocks other web pages driving DSH through the entrance). Headers are passed
 *     to DSH unchanged, so DSH's own Host/Origin fence still applies.
 *   - Requests from this PC's loopback are trusted. Every other device must pair
 *     once with the passcode; pairing sets a signed HttpOnly cookie on that browser.
 *     Wrong passcodes are rate limited.
 *   - The passcode and the cookie signing key live in
 *     $DSH_HOME/dsh-chat-ui/entry-pairing.json (never in this package).
 *   Home-LAN use only; do not port-forward. The Windows firewall may ask to allow
 *   the port the first time.
 */
import { spawn } from 'node:child_process'
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

/** Pick one LAN-side IPv4 for `--host lan`. */
function detectLanIp() {
  const candidates = []
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      candidates.push({ name, address: address.address })
    }
  }
  // Prefer real adapters and private ranges over virtual/VPN ones.
  candidates.sort((a, b) => {
    const virtual = (c) => (/vEthernet|WSL|VirtualBox|VMware|Tailscale|ZeroTier|Hyper-V/i.test(c.name) ? 1 : 0)
    const score = (c) =>
      /^(192\.168\.|10\.)/.test(c.address) ? 0 : /^172\.(1[6-9]|2\d|3[01])\./.test(c.address) ? 1 : 2
    return virtual(a) - virtual(b) || score(a) - score(b)
  })
  return candidates[0]?.address ?? '127.0.0.1'
}

/** Find the DSH CLI: explicit flag, env, a sibling install, then PATH. */
function resolveDshBin() {
  const explicit = readArg('--dsh-bin', process.env.DSH_BIN)
  if (explicit) return { command: explicit, kind: 'node' }

  const here = path.dirname(fileURLToPath(import.meta.url))
  let dir = here
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(candidate)) return { command: candidate, kind: 'node' }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { command: 'dsh', kind: 'path' }
}

const isLoopbackHost = (value) => value === '127.0.0.1' || value === '::1' || value === 'localhost'

let host = readArg('--host', '127.0.0.1')
if (host === 'lan') host = detectLanIp()
const port = Number(readArg('--port', '8124'))
const entryPort = Number(readArg('--entry-port', '8123'))
const dshHome = readArg('--dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
const quiet = args.includes('--quiet')
// LAN のときは IP ではなくホスト名でも案内する。IP が変わってもブックマークが生きる。
// macOS の os.hostname() は既に ".local" 付きのことがあるので二重にしない。
const stableHost = readArg('--hostname', `${os.hostname().replace(/\.local$/i, '')}.local`)
const showStable = !isLoopbackHost(host) && !args.includes('--no-hostname')

const fail = (message) => {
  console.error(`dsh-chat-ui: ${message}`)
  process.exit(1)
}
const isPort = (value) => Number.isInteger(value) && value > 0 && value <= 65535

if (!isPort(port)) fail(`--port must be a TCP port, got ${JSON.stringify(readArg('--port', '8124'))}`)
if (!isPort(entryPort)) fail(`--entry-port must be a TCP port, got ${JSON.stringify(readArg('--entry-port', '8123'))}`)
if (host === '0.0.0.0' || host === '::') {
  // DSH refuses wildcard binds; picking the LAN address is what users actually mean.
  fail('wildcard bind is not supported — use "--host lan" (this machine\'s LAN address) or a concrete IPv4.')
}
if (entryPort === port) fail(`--port and --entry-port must differ (both ${port})`)

// LAN のときは既定でプロキシ（URL が入口のまま変わらない）。ループバックは転送のまま。
const mode = readArg('--mode', isLoopbackHost(host) ? 'redirect' : 'proxy')
if (mode !== 'proxy' && mode !== 'redirect') fail(`--mode must be "proxy" or "redirect", got ${JSON.stringify(mode)}`)
if (mode === 'redirect' && !isLoopbackHost(host)) {
  // redirect は token 付き URL をそのまま返すので、LAN に出すと同じネットワークの誰でも
  // DSH を操作できてしまう。LAN ではパスコード付きのプロキシだけを許す。
  fail('--mode redirect is loopback only (it hands the token URL to anyone who can reach it). Use the default proxy mode on a LAN address.')
}

// proxy モードでは DSH 本体をループバックの別ポートに置き、`--port`（これまでの 8124）は
// 昔のブックマーク救済用の転送にする。古い :8124 を開いても入口へ流れるので 401 にならない。
const upstreamPort = Number(readArg('--upstream-port', mode === 'proxy' ? String(port + 1) : String(port)))
if (!isPort(upstreamPort)) fail(`--upstream-port must be a TCP port, got ${JSON.stringify(readArg('--upstream-port', ''))}`)
if (mode === 'proxy' && (upstreamPort === entryPort || upstreamPort === port)) {
  fail(`--upstream-port (${upstreamPort}) must differ from --entry-port and --port`)
}
const upstreamHost = mode === 'proxy' ? '127.0.0.1' : host

let currentUrl = null
let child = null

const log = (...parts) => {
  if (!quiet) console.log('dsh-chat-ui:', ...parts)
}

// ---------------------------------------------------------------------------
// Request gate (proxy mode)
// ---------------------------------------------------------------------------

// 入口として受け付けるホスト名。これ以外の Host は DNS rebinding とみなして断る。
const allowedHostnames = new Set(['127.0.0.1', 'localhost', host.toLowerCase()])
if (showStable && stableHost) allowedHostnames.add(stableHost.toLowerCase())

/**
 * The request's own authority (`host:port`, lowercased) when it names this
 * entrance, otherwise null.
 * @param {import('node:http').IncomingHttpHeaders} headers
 */
function entranceAuthority(headers) {
  const raw = headers.host
  if (typeof raw !== 'string' || raw === '') return null
  let url
  try {
    url = new URL(`http://${raw}`)
  } catch {
    return null
  }
  if (!allowedHostnames.has(url.hostname)) return null
  if ((url.port || '80') !== String(entryPort)) return null
  return url.host
}

/**
 * Browser markers must say "this page came from the entrance itself".
 * A request without them (curl, a direct navigation) passes; DSH applies the
 * same rule again upstream because the headers are forwarded unchanged.
 */
function isSameOriginRequest(headers, authority) {
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && url.host === authority
  } catch {
    return false
  }
}

const isLoopbackAddress = (address) =>
  typeof address === 'string' && (address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.'))

// ---------------------------------------------------------------------------
// Pairing (proxy mode): passcode once per device, then a signed cookie
// ---------------------------------------------------------------------------

const PAIR_COOKIE = 'dsh_chat_ui_pair'
const PAIR_PATH = '/__dsh-chat-ui/pair'
const PAIR_MAX_AGE_SECONDS = 400 * 24 * 60 * 60 // browsers cap cookie lifetime at 400 days
const PASSCODE_DIGITS = 8
const FAIL_WINDOW_MS = 10 * 60 * 1000
const FAIL_LIMIT_PER_ADDRESS = 5
const FAIL_LIMIT_GLOBAL = 20

/** Load (or create) the passcode and signing key kept in DSH_HOME, never in the package. */
function loadPairing(reset) {
  const file = path.join(dshHome, 'dsh-chat-ui', 'entry-pairing.json')
  if (!reset) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      const valid =
        data?.version === 1 &&
        typeof data.passcode === 'string' &&
        new RegExp(`^\\d{${PASSCODE_DIGITS}}$`).test(data.passcode) &&
        typeof data.secret === 'string' &&
        data.secret.length >= 43
      if (valid) return { passcode: data.passcode, secret: data.secret, file, created: false }
    } catch {
      // missing or unreadable: issue a new one below
    }
  }
  const data = {
    version: 1,
    passcode: String(randomInt(0, 10 ** PASSCODE_DIGITS)).padStart(PASSCODE_DIGITS, '0'),
    secret: randomBytes(32).toString('base64url'),
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  return { passcode: data.passcode, secret: data.secret, file, created: true }
}

const pairing = mode === 'proxy' ? loadPairing(args.includes('--reset-pairing')) : null

const sign = (payload) => createHmac('sha256', pairing.secret).update(payload).digest('base64url')

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function issuePairCookie() {
  const payload = `v1.${Math.floor(Date.now() / 1000)}`
  return `${PAIR_COOKIE}=${payload}.${sign(payload)}; Max-Age=${PAIR_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Strict`
}

function readCookie(header, name) {
  if (typeof header !== 'string') return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return null
}

function hasValidPairCookie(headers) {
  const value = readCookie(headers.cookie, PAIR_COOKIE)
  if (!value) return false
  const match = /^(v1\.(\d{1,12}))\.([A-Za-z0-9_-]+)$/.exec(value)
  if (!match) return false
  const issuedAt = Number(match[2])
  const age = Date.now() / 1000 - issuedAt
  if (!(age >= -300 && age <= PAIR_MAX_AGE_SECONDS)) return false
  return safeEqual(match[3], sign(match[1]))
}

// 総当たり対策: 間違いは 10 分あたり 1 アドレス 5 回・全体 20 回まで。
const failures = new Map()
let globalFailures = { count: 0, resetAt: 0 }

function isLockedOut(address) {
  const now = Date.now()
  if (globalFailures.resetAt <= now) globalFailures = { count: 0, resetAt: now + FAIL_WINDOW_MS }
  const entry = failures.get(address)
  if (entry && entry.resetAt <= now) failures.delete(address)
  return globalFailures.count >= FAIL_LIMIT_GLOBAL || (failures.get(address)?.count ?? 0) >= FAIL_LIMIT_PER_ADDRESS
}

function recordFailure(address) {
  const now = Date.now()
  const entry = failures.get(address)
  if (!entry || entry.resetAt <= now) failures.set(address, { count: 1, resetAt: now + FAIL_WINDOW_MS })
  else entry.count += 1
  globalFailures.count += 1
}

const prefersJapanese = (headers) => /^\s*ja\b/i.test(String(headers['accept-language'] ?? ''))

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function pairPage(headers, message) {
  const ja = prefersJapanese(headers)
  const t = ja
    ? {
        lang: 'ja',
        title: 'この端末を登録',
        lead: 'PC の入口を起動した画面に出ている 8 桁のパスコードを入力してください。登録は端末ごとに 1 回だけです。',
        label: 'パスコード',
        submit: '登録する',
      }
    : {
        lang: 'en',
        title: 'Pair this device',
        lead: 'Enter the 8-digit passcode shown where the entrance was started on the PC. Each device pairs once.',
        label: 'Passcode',
        submit: 'Pair',
      }
  const error = message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ''
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="${APP_COLOR}">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${t.title}</title>
<style>
  :root { --bg: #212121; --card: #2f2f2f; --text: #ececec; --muted: #b4b4b4; --border: #ffffff26; --accent: #ececec; --accent-text: #0d0d0d; --error: #ff8f8f; }
  @media (prefers-color-scheme: light) {
    :root { --bg: #ffffff; --card: #f4f4f4; --text: #0d0d0d; --muted: #5d5d5d; --border: #0000001a; --accent: #0d0d0d; --accent-text: #ffffff; --error: #b3261e; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", Meiryo, "Noto Sans JP", sans-serif; }
  main { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: var(--muted); font-size: 14px; line-height: 1.6; margin: 0 0 16px; }
  label { display: block; font-size: 14px; margin-bottom: 6px; }
  input { width: 100%; font-size: 22px; letter-spacing: 0.2em; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border);
    background: var(--bg); color: var(--text); }
  button { width: 100%; margin-top: 16px; min-height: 44px; font-size: 16px; font-weight: 600; border: 0; border-radius: 22px;
    background: var(--accent); color: var(--accent-text); cursor: pointer; }
  .error { color: var(--error); }
</style>
</head>
<body>
<main>
<h1>${t.title}</h1>
<p>${t.lead}</p>
${error}
<form method="post" action="${PAIR_PATH}">
<label for="code">${t.label}</label>
<input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="${PASSCODE_DIGITS}" autocomplete="one-time-code" required autofocus>
<button type="submit">${t.submit}</button>
</form>
</main>
</body>
</html>
`
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // no-referrer にするとフォーム送信の Origin が "null" になり、同一オリジン判定で弾かれる
  'referrer-policy': 'same-origin',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'",
}

// ---------------------------------------------------------------------------
// Home-screen app (proxy mode): manifest and icons
// ---------------------------------------------------------------------------
//
// 「ホーム画面に追加」でアプリとして開けるようにする。DSH 自身の manifest は
// display: fullscreen（ステータスバーまで消える）で、アイコンも SVG だけなので
// iPhone のホーム画面では画面の縮小画像になる。入口がこれを差し替える。
// manifest とアイコンはブラウザが cookie なしで取りに来るので、登録前でも返す
// （秘密は含まない。Host と送信元の検査は通常どおり）。

const APP_COLOR = '#212121'
const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const APP_ICONS = {
  '/apple-touch-icon.png': 'apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png': 'apple-touch-icon.png',
  '/__dsh-chat-ui/icon-192.png': 'icon-192.png',
  '/__dsh-chat-ui/icon-512.png': 'icon-512.png',
  '/__dsh-chat-ui/icon-maskable-512.png': 'icon-maskable-512.png',
}
const iconCache = new Map()

function appManifest(headers) {
  const name = prefersJapanese(headers) ? 'DSH チャット' : 'DSH Chat'
  return {
    id: '/',
    name,
    short_name: name,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: APP_COLOR,
    theme_color: APP_COLOR,
    icons: [
      { src: '/__dsh-chat-ui/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/__dsh-chat-ui/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/__dsh-chat-ui/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}

/**
 * Tags added to DSH's page so that "Add to Home Screen" makes an app, not a
 * bookmark. iOS reads these from the page itself (the manifest alone is not
 * always enough), Android/desktop Chrome read the manifest.
 */
function appHeadTags(headers) {
  const name = prefersJapanese(headers) ? 'DSH チャット' : 'DSH Chat'
  return [
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="mobile-web-app-capable" content="yes">',
    `<meta name="apple-mobile-web-app-title" content="${name}">`,
    '<meta name="apple-mobile-web-app-status-bar-style" content="black">',
    `<meta name="theme-color" content="${APP_COLOR}">`,
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  ].join('')
}

/** A top-level page load (the only response whose HTML is touched). */
const isPageLoad = (request) =>
  request.method === 'GET' &&
  (request.headers['sec-fetch-dest'] === 'document' || /text\/html/.test(String(request.headers.accept ?? '')))

/** Insert {@link appHeadTags} right after `<head>`; leaves the page as is when there is none. */
function withAppTags(html, headers) {
  const match = /<head\b[^>]*>/i.exec(html)
  if (!match) return html
  const at = match.index + match[0].length
  return html.slice(0, at) + appHeadTags(headers) + html.slice(at)
}

/** Serve the manifest or an icon; returns false for any other path. */
function serveAppAsset(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const head = request.method === 'HEAD'
  if (pathname === '/manifest.webmanifest') {
    request.resume()
    response.writeHead(200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      vary: 'Accept-Language',
    })
    response.end(head ? undefined : JSON.stringify(appManifest(request.headers), null, 2))
    return true
  }
  const file = APP_ICONS[pathname]
  if (!file) return false
  request.resume()
  let body = iconCache.get(file)
  if (!body) {
    try {
      body = readFileSync(path.join(ASSET_DIR, file))
      iconCache.set(file, body)
    } catch {
      sendText(response, 404, 'not found')
      return true
    }
  }
  response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' })
  response.end(head ? undefined : body)
  return true
}

function sendPairPage(request, response, status, message) {
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' })
  response.end(request.method === 'HEAD' ? undefined : pairPage(request.headers, message))
}

function sendText(response, status, text, extra = {}) {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', ...extra })
  response.end(text)
}

/** POST /__dsh-chat-ui/pair with `code=<passcode>` (form-urlencoded). */
function handlePair(request, response) {
  const address = request.socket.remoteAddress ?? 'unknown'
  const ja = prefersJapanese(request.headers)
  if (isLockedOut(address)) {
    sendPairPage(request, response, 429, ja ? '間違いが続いたため、10 分ほど待ってから試してください。' : 'Too many attempts. Wait about 10 minutes and try again.')
    request.resume()
    return
  }
  let body = ''
  let tooLarge = false
  request.setEncoding('utf8')
  request.on('data', (chunk) => {
    if (tooLarge) return
    body += chunk
    if (body.length > 1024) tooLarge = true
  })
  request.on('end', () => {
    if (tooLarge) return sendText(response, 413, 'payload too large')
    const code = (new URLSearchParams(body).get('code') ?? '').replace(/\s+/g, '')
    if (code !== '' && safeEqual(code, pairing.passcode)) {
      failures.delete(address)
      log(`paired a device from ${address}`)
      response.writeHead(303, { ...SECURITY_HEADERS, location: '/', 'set-cookie': issuePairCookie() })
      response.end()
      return
    }
    recordFailure(address)
    log(`wrong passcode from ${address}`)
    sendPairPage(request, response, 401, ja ? 'パスコードが違います。' : 'That passcode is not correct.')
  })
}

/**
 * Decide whether a proxy-mode request may reach DSH.
 * @returns {{ ok: true, authority: string } | { ok: false, status: number, reason: string }}
 */
function gate(request) {
  const authority = entranceAuthority(request.headers)
  if (!authority) return { ok: false, status: 403, reason: 'unknown host' }
  if (!isSameOriginRequest(request.headers, authority)) return { ok: false, status: 403, reason: 'cross-site request' }
  return { ok: true, authority }
}

const isPaired = (request) => isLoopbackAddress(request.socket.remoteAddress) || hasValidPairCookie(request.headers)

// ---------------------------------------------------------------------------
// Upstream authentication (proxy mode)
// ---------------------------------------------------------------------------

// DSH の認証 cookie は Host（authority）ごとに発行される。入口は Host をそのまま上流へ
// 渡すので、authority ごとに token 付き URL から 1 回取り、期限切れ（401）なら取り直す。
const upstreamCookies = new Map()

function captureAuthCookie(authority) {
  return new Promise((resolve) => {
    if (!currentUrl) return resolve(null)
    const tokenPath = currentUrl.replace(/^https?:\/\/[^/]+/, '')
    const request = http.request(
      { host: upstreamHost, port: upstreamPort, method: 'GET', path: tokenPath, headers: { host: authority } },
      (response) => {
        const setCookie = response.headers['set-cookie']
        const value = Array.isArray(setCookie) ? setCookie.map((line) => line.split(';')[0]).join('; ') : null
        response.resume()
        if (value) log(`auth cookie captured for ${authority}`)
        else log(`auth cookie missing in the token response for ${authority}`)
        resolve(value)
      },
    )
    request.on('error', (error) => {
      log('auth cookie capture failed:', error.message)
      resolve(null)
    })
    request.end()
  })
}

function upstreamCookie(authority) {
  const cached = upstreamCookies.get(authority)
  if (cached) return cached
  const pending = captureAuthCookie(authority).then((value) => {
    if (!value) upstreamCookies.delete(authority)
    return value
  })
  upstreamCookies.set(authority, pending)
  return pending
}

/**
 * Headers for DSH: the browser's own Host / Origin / Referer / Sec-Fetch-* are
 * kept so DSH's Host/Origin fence still judges the real request. Only the
 * cookie is replaced (the pairing cookie never reaches DSH).
 */
function upstreamHeaders(incoming, cookie) {
  const headers = { ...incoming }
  delete headers.cookie
  if (cookie) headers.cookie = cookie
  return headers
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

function startDsh() {
  const { command, kind } = resolveDshBin()
  const dshArgs = ['web', '--no-open', '--port', String(upstreamPort), '--host', upstreamHost]
  if (mode === 'proxy') {
    // Host をそのまま渡すので、入口の authority を DSH に信頼させる（ループバックは既定で信頼される）
    dshArgs.push('--trusted-host', `${host}:${entryPort}`)
    if (showStable && stableHost) dshArgs.push('--trusted-host', `${stableHost}:${entryPort}`)
  }
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    // Session logs are uploaded by default on the official API; this opt-out is
    // the safe default for a distributed client.
    DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE ?? 'DISABLED',
    DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED ?? '1',
  }
  log(`starting: ${kind === 'node' ? 'node ' : ''}${command} ${dshArgs.join(' ')}`)
  log(`DSH_HOME=${dshHome}`)
  child =
    kind === 'node'
      ? spawn(process.execPath, [command, ...dshArgs], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      : spawn(command, dshArgs, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: true, windowsHide: true })

  let buffered = ''
  child.stdout.on('data', (chunk) => {
    if (currentUrl) return
    buffered = (buffered + chunk.toString()).slice(-8192)
    const match = buffered.match(/https?:\/\/[^\s]+\?token=[A-Za-z0-9_-]+/)
    if (!match) return
    currentUrl = match[0]
    buffered = ''
    log('ready:', currentUrl.replace(/token=[^&]+/, 'token=***'))
    if (showStable) log(`entrance: http://${stableHost}:${entryPort}/   (same bookmark when the IP changes)`)
    log(`entrance: http://${host}:${entryPort}/`)
    log(`mode: ${mode}`)
    if (mode === 'proxy') {
      // 表示は 4 桁ずつ区切る（入力は区切りなしでも可）
      log(`passcode: ${pairing.passcode.replace(/(\d{4})(?=\d)/g, '$1 ')}   (enter once on each phone / other device; this PC needs none)`)
      log(`passcode file: ${pairing.file}${pairing.created ? ' (new)' : ''}   (--reset-pairing issues a new one and unpairs every device)`)
    }
  })
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  child.on('exit', (code, signal) => {
    log(`dsh web exited (${signal ? `signal ${signal}` : `code ${code}`})`)
    process.exit(code ?? 1)
  })
}

function handleProxyRequest(request, response) {
  const verdict = gate(request)
  if (!verdict.ok) {
    request.resume()
    return sendText(response, verdict.status, `dsh-chat-ui: forbidden (${verdict.reason})`)
  }
  const url = request.url ?? '/'
  const pathname = url.split('?')[0]

  if (serveAppAsset(request, response, pathname)) return

  if (pathname === PAIR_PATH) {
    if (request.method === 'POST') return handlePair(request, response)
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (isPaired(request)) {
        response.writeHead(303, { ...SECURITY_HEADERS, location: '/' })
        return response.end()
      }
      return sendPairPage(request, response, 200)
    }
    request.resume()
    return sendText(response, 405, 'method not allowed', { allow: 'GET, HEAD, POST' })
  }

  if (!isPaired(request)) {
    request.resume()
    const wantsPage = (request.method === 'GET' || request.method === 'HEAD') && /text\/html/.test(String(request.headers.accept ?? ''))
    if (wantsPage) return sendPairPage(request, response, 401)
    return sendText(response, 401, 'dsh-chat-ui: this device is not paired yet. Open the entrance page and enter the passcode.')
  }

  if (!currentUrl) {
    request.resume()
    return sendText(response, 503, 'DSH web is starting. Reload in a few seconds.')
  }

  // ボディのある要求は再送できないので、cookie を確定させてから 1 回だけ流す。
  // ボディの無い GET/HEAD だけ、cookie 切れ（401）の時に取り直して 1 回再試行する。
  const replayable = request.method === 'GET' || request.method === 'HEAD'
  // ページ本体だけは、ホーム画面のアプリ用のタグを足すので圧縮なしで受け取る
  const pageLoad = isPageLoad(request)
  const forward = async (retry) => {
    const cookie = await upstreamCookie(verdict.authority)
    const headers = upstreamHeaders(request.headers, cookie)
    if (pageLoad) headers['accept-encoding'] = 'identity'
    const upstream = http.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: request.method,
        path: url,
        headers,
      },
      (upstreamResponse) => {
        if (upstreamResponse.statusCode === 401) {
          upstreamCookies.delete(verdict.authority)
          if (retry && replayable) {
            upstreamResponse.resume()
            forward(false)
            return
          }
        }
        const isHtml = /^text\/html\b/i.test(String(upstreamResponse.headers['content-type'] ?? ''))
        const encoded = String(upstreamResponse.headers['content-encoding'] ?? 'identity') !== 'identity'
        if (pageLoad && upstreamResponse.statusCode === 200 && isHtml && !encoded) {
          const chunks = []
          upstreamResponse.on('data', (chunk) => chunks.push(chunk))
          upstreamResponse.on('end', () => {
            const body = Buffer.from(withAppTags(Buffer.concat(chunks).toString('utf8'), request.headers), 'utf8')
            const outHeaders = { ...upstreamResponse.headers, 'content-length': String(body.length) }
            delete outHeaders.etag
            delete outHeaders['transfer-encoding']
            response.writeHead(200, outHeaders)
            response.end(body)
          })
          upstreamResponse.on('error', () => response.destroy())
          return
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      },
    )
    upstream.on('error', (error) => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`dsh-chat-ui: upstream error: ${error.message}`)
    })
    if (replayable) upstream.end()
    else request.pipe(upstream)
  }
  forward(true).catch((error) => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`dsh-chat-ui: upstream error: ${error?.message ?? error}`)
  })
}

function handleRedirectRequest(request, response) {
  request.resume()
  if (!currentUrl) return sendText(response, 503, 'DSH web is starting. Reload in a few seconds.')
  response.writeHead(302, { location: currentUrl, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end()
}

const handleRequest = mode === 'proxy' ? handleProxyRequest : handleRedirectRequest

const rejectUpgrade = (socket, status, text) => {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

// WebSocket（/api のライブ接続）も同じ門を通してから中継する。
const handleUpgrade = (request, socket, head) => {
  socket.on('error', () => socket.destroy())
  if (mode !== 'proxy') return rejectUpgrade(socket, 404, 'Not Found')
  const verdict = gate(request)
  if (!verdict.ok) return rejectUpgrade(socket, 403, 'Forbidden')
  if (!isPaired(request)) return rejectUpgrade(socket, 401, 'Unauthorized')
  if (!currentUrl) return rejectUpgrade(socket, 503, 'Service Unavailable')
  upstreamCookie(verdict.authority).then((cookie) => {
    if (socket.destroyed) return
    const upstream = net.connect(upstreamPort, upstreamHost, () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`]
      for (const [key, value] of Object.entries(upstreamHeaders(request.headers, cookie))) {
        if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
        else if (value !== undefined) lines.push(`${key}: ${value}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
  })
}

// LAN の IP と、この PC 自身（127.0.0.1）の両方で待受ける。
// PC の古いタブが http://127.0.0.1:8124/ を指していることがあるため。
// 1 つの http.Server に複数アドレスを listen させると片方しか残らないので、アドレスごとに作る。
const bindAddresses = isLoopbackHost(host) ? [host] : [host, '127.0.0.1']

const servers = []
const onListenError = (error) => {
  console.error('dsh-chat-ui: cannot listen:', error.message)
  killChild()
  process.exit(1)
}

let started = false
for (const address of bindAddresses) {
  const instance = http.createServer(handleRequest)
  instance.on('upgrade', handleUpgrade)
  instance.on('error', onListenError)
  instance.listen(entryPort, address, () => {
    log(`entry listening on http://${address}:${entryPort}/`)
    if (!started) {
      started = true
      startDsh()
    }
  })
  servers.push(instance)
}

// 昔の :8124（いまは DSH 本体ではない）を開いた時の受け皿。入口へ転送するだけで、
// token は出さない。転送先のホスト名は入口が受け付けるものに限る（Host をそのまま反射しない）。
const legacyServers = []
if (mode === 'proxy') {
  for (const address of bindAddresses) {
    const instance = http.createServer((request, response) => {
      request.resume()
      let target = host
      try {
        const requested = new URL(`http://${request.headers.host ?? ''}`).hostname
        if (allowedHostnames.has(requested)) target = requested
      } catch {
        // keep the default
      }
      response.writeHead(302, {
        location: `http://${target}:${entryPort}/`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      response.end()
    })
    instance.on('error', (error) => log(`legacy port ${port} (${address}) unavailable: ${error.message}`))
    instance.listen(port, address, () => log(`legacy entrance: http://${address}:${port}/ -> :${entryPort}`))
    legacyServers.push(instance)
  }
}

function killChild() {
  if (!child || child.killed || child.exitCode !== null) return
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill()
}

const shutdown = () => {
  log('shutting down')
  killChild()
  for (const instance of legacyServers) instance.close()
  for (const instance of servers) instance.close()
  setTimeout(() => process.exit(0), 300).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
