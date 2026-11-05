#!/usr/bin/env node
/**
 * Embed the Japanese dictionary into client.js.
 *
 * The DSH web client loads a plugin as ONE script, so a sibling JSON file cannot
 * be imported at runtime. This script inlines `locale/ja.json` between the
 * marker comments in client.js. Run it whenever locale/ja.json changes:
 *
 *   node tools/embed-ja.mjs
 *   node tools/embed-ja.mjs --check   # fail if client.js is out of date
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const clientPath = join(root, 'client.js')
const dictPath = join(root, 'locale', 'ja.json')

const START = '// <ja-dictionaries>'
const END = '// </ja-dictionaries>'

const dictionary = JSON.parse(readFileSync(dictPath, 'utf8'))
const count = Object.values(dictionary).reduce((sum, namespace) => sum + Object.keys(namespace ?? {}).length, 0)
const block = `${START}\n    const JA_DICTIONARIES = ${JSON.stringify(dictionary)}\n    ${END}`

const source = readFileSync(clientPath, 'utf8')
const startIndex = source.indexOf(START)
const endIndex = source.indexOf(END)
if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
  console.error('embed-ja: marker comments not found in client.js')
  process.exit(1)
}

const next = source.slice(0, startIndex) + block + source.slice(endIndex + END.length)

if (process.argv.includes('--check')) {
  if (next !== source) {
    console.error('embed-ja: client.js is out of date — run `node tools/embed-ja.mjs`')
    process.exit(1)
  }
  console.log(`embed-ja: up to date (${Object.keys(dictionary).length} namespaces, ${count} keys)`)
} else {
  writeFileSync(clientPath, next)
  console.log(`embed-ja: wrote ${Object.keys(dictionary).length} namespaces, ${count} keys into client.js`)
}
