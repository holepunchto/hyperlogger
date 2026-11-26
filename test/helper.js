const fs = require('fs')
const path = require('path')
const hrtime = require('#hrtime')
const Hyperlogger = require('../index')
const FileLog = require('../lib/file-logger')

async function createLogger(t, opts = {}) {
  // loggers have separate directories
  const dir = await t.tmp()
  const file = path.join(dir, 'app.log')
  const logger = new Hyperlogger({ file, ...opts })

  t.teardown(() => logger.close())

  return { file, logger }
}

function captureConsole(fn) {
  const methods = ['debug', 'info', 'warn', 'error', 'log']
  const original = {}
  const calls = []

  for (const m of methods) {
    original[m] = console[m]
    console[m] = (...args) => calls.push([m, ...args])
  }

  try {
    fn()
  } finally {
    for (const m of methods) console[m] = original[m]
  }

  return calls
}

// Control hrtime for the length of one test, so timing tests don't wait real time
function hrtimeClock(t) {
  const bigint = hrtime.bigint
  let time = bigint()

  hrtime.bigint = () => time

  t.teardown(() => {
    hrtime.bigint = bigint
  })

  return {
    advance(ms) {
      time += BigInt(ms * 1_000_000)
    }
  }
}

function severities(file) {
  return readLines(file).map((record) => record.severityText)
}

// the duration in a timing body ("label: 12.345ms ..." or "label: 1.234s ..."), in ms
function durationMs(body) {
  const [, value, unit] = body.match(/: (\d+\.\d{3})(ms|s)/)
  return Number(value) * (unit === 's' ? 1000 : 1)
}

function bodies(file) {
  return readLines(file).map((record) => record.body)
}

function readLines(file) {
  if (!fs.existsSync(file)) return []
  return Hyperlogger.parseLogs(fs.readFileSync(file, 'utf8'))
}

// Swap an fs function for the length of one test
function stubfs(t, name, fn) {
  const original = fs[name]

  fs[name] = fn

  t.teardown(() => {
    fs[name] = original
  })

  return original
}

// Control Date.now for the length of one test
function dateClock(t) {
  const now = Date.now
  let time = now()

  Date.now = () => time

  t.teardown(() => {
    Date.now = now
  })

  return {
    advance(ms) {
      time += ms
    }
  }
}

function fail(code) {
  return () => {
    const err = new Error(code)
    err.code = code

    throw err
  }
}

async function setup(t, opts = {}) {
  const dir = await t.tmp()
  const file = path.join(dir, 'app.log')

  const log = new FileLog(file, { maxSize: 40, ...opts })

  t.teardown(() => log.close())

  return { file, log }
}

function line(i) {
  return JSON.stringify(record(i)) + '\n'
}

// fixed-width records, so every line is the same number of bytes
function record(i) {
  return { i: String(i).padStart(4, '0'), pad: 'x'.repeat(20) }
}

// every line across the rotated files, oldest first
function readAll(file) {
  const all = []
  for (let i = FileLog.LOG_FILES - 1; i >= 1; i--) all.push(...lines(`${file}.${i}`))
  all.push(...lines(file))
  return all
}

function lines(file) {
  return contents(file).split('\n').filter(Boolean)
}

function contents(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

module.exports = {
  createLogger,
  captureConsole,
  hrtimeClock,
  severities,
  durationMs,
  bodies,
  readLines,
  stubfs,
  dateClock,
  fail,
  setup,
  line,
  record,
  readAll,
  lines,
  contents
}
