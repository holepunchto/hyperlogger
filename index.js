const path = require('path')
const fs = require('fs')
const FileLog = require('./lib/file-logger')
const SystemLog = require('#system-logger')
const hrtime = require('#hrtime')
const format = require('#format')
const normaliseAttributes = require('./lib/normalise')
const { createOptions } = normaliseAttributes

const LEVELS = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 }

// one FileLog per file, shared by every logger writing to it,
// prevents two loggers on the same path rotating files under one another
const files = new Map()

function acquire(filePath, maxSize) {
  const key = path.resolve(filePath)
  let entry = files.get(key)

  if (entry === undefined) {
    // created before it's stored, so a constructor error leaves no broken entry
    entry = { file: new FileLog(key, { maxSize }), users: 0, maxSize }
    files.set(key, entry)
  }

  entry.users++

  return { key, file: entry.file }
}

function release(key) {
  const entry = files.get(key)
  if (entry === undefined || --entry.users > 0) return

  files.delete(key)
  entry.file.close()
}

class Hyperlogger {
  constructor({
    dev = false,
    verbose = false,
    file,
    level = 'INFO',
    maxTotalSize,
    maxDepth,
    maxBytes
  } = {}) {
    this._muted = false
    this._dev = dev
    this._verbose = verbose
    this._level = checkLevel(level)
    this._system = new SystemLog()
    this._timers = new Map()
    this._normaliseOpts = createOptions({ maxDepth, maxBytes })
    this._closed = false

    // logs are split across N files sharing total size (100MB default)
    const maxFileSize = maxTotalSize ? Math.ceil(maxTotalSize / FileLog.LOG_FILES) : undefined

    this._file = null
    this._fileKey = null
    if (file) ({ key: this._fileKey, file: this._file } = acquire(file, maxFileSize))
  }

  static LEVELS = LEVELS

  // logs in write order
  static readLogs(filePath) {
    const last = FileLog.LOG_FILES - 1
    const logs = []

    for (let i = last; i >= 0; i--) {
      try {
        let raw

        if (i === 0) raw = fs.readFileSync(filePath, { encoding: 'utf8' })
        else raw = fs.readFileSync(`${filePath}.${i}`, { encoding: 'utf8' })

        logs.push(...Hyperlogger.parseLogs(raw))
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }

    return logs
  }

  static parseLogs(rawLogs) {
    const logLines = rawLogs.split('\n')

    const logs = []
    for (const log of logLines) {
      try {
        logs.push(JSON.parse(log))
      } catch {}
    }

    return logs
  }

  close() {
    if (this._closed) return

    this._closed = true

    this._timers.clear()

    const key = this._fileKey
    this._file = null
    this._fileKey = null
    if (key !== null) release(key)
  }

  mute() {
    this._muted = true
  }

  unmute() {
    this._muted = false
  }

  debug(...args) {
    this._write('DEBUG', ...args)
  }

  verboseDebug(...args) {
    if (!this._verbose) return
    this._write('DEBUG', ...args)
  }

  info(...args) {
    this._write('INFO', ...args)
  }

  verboseInfo(...args) {
    if (!this._verbose) return
    this._write('INFO', ...args)
  }

  warn(...args) {
    this._write('WARN', ...args)
  }

  error(...args) {
    this._write('ERROR', ...args)
  }

  time(label) {
    this._timers.set(label, hrtime.bigint())
  }

  timeLog(label, ...data) {
    const started = this._timers.get(label)
    if (started === undefined) return
    this.info(`${label}: ${formatElapsed(hrtime.bigint() - started)}`, ...data)
  }

  timeEnd(label, ...data) {
    this.timeLog(label, ...data)
    this._timers.delete(label)
  }

  _write(level, ...args) {
    if (this._muted || this._closed) return
    if (LEVELS[level] < this._level) return

    // if log attributes have been provided extract them
    let attributes = {}
    if (isPlainObject(args[args.length - 1])) {
      attributes = normaliseAttributes(args.pop(), this._normaliseOpts)
    }

    const body = args.map((arg) => format(arg)).join(' ')

    const log = this._buildRecord(level, body, attributes)
    const method = level.toLowerCase()

    // just for dev purposes
    if (this._dev && this._level === LEVELS.DEBUG) {
      const log = console[method] || console.log
      log(...args)
    }

    this._system[method](body)

    if (this._file) this._file.write(log)
  }

  _buildRecord(level, body, attributes) {
    const timeUnixNano = Date.now() + '000000'

    return {
      timeUnixNano,
      observedTimeUnixNano: timeUnixNano,
      severityNumber: LEVELS[level],
      severityText: level,
      body,
      attributes
    }
  }
}

module.exports = Hyperlogger

function formatElapsed(ns) {
  const ms = Number(ns) / 1e6
  return ms > 1000 ? `${(ms / 1000).toFixed(3)}s` : `${ms.toFixed(3)}ms`
}

function checkLevel(level) {
  if (!Object.hasOwn(LEVELS, level)) throw new RangeError(`Invalid log level: ${level}`)

  return LEVELS[level]
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
