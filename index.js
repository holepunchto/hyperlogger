const FileLog = require('./lib/file-logger')
const SystemLog = require('#system-logger')
const hrtime = require('#hrtime')
const normaliseAttribute = require('./lib/normalise.js')

const LEVELS = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 }

class Hyperlogger {
  static LEVELS = LEVELS

  static parseLogs(rawLogs) {
    const logLines = rawLogs.split('\n')

    const logs = []
    for (const log of logLines) {
      // ignore final newline
      if (log === '') continue
      logs.push(JSON.parse(log))
    }

    return logs
  }

  constructor({ dev = false, verbose = false, logFile, logLevel = 'INFO', logFileMaxSize } = {}) {
    this._muted = false
    this._dev = dev
    this.verbose = verbose
    this.level = LEVELS[logLevel.toUpperCase()] ?? LEVELS.INFO
    this._system = new SystemLog()
    this._file = logFile ? new FileLog(logFile, { maxSize: logFileMaxSize || 100_000_000 }) : null
    this._timers = new Map()
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
    if (!this.verbose) return
    this._write('DEBUG', ...args)
  }

  info(...args) {
    this._write('INFO', ...args)
  }

  verboseInfo(...args) {
    if (!this.verbose) return
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
    if (this._muted) return
    if (LEVELS[level] < this.level) return

    // if log attributes have been provided extract them
    let attributes = {}
    if (isPlainObject(args[args.length - 1])) {
      attributes = normaliseAttribute(args.pop())
    }

    const timeUnixNano = (BigInt(Date.now()) * 1_000_000n).toString()

    const log = {
      timeUnixNano,
      observedTimeUnixNano: timeUnixNano,
      severityNumber: LEVELS[level],
      severityText: level,
      body: args.join(' '),
      attributes
    }
    const method = level.toLowerCase()

    // just for dev purposes
    if (this._dev && this.level === LEVELS.DEBUG) {
      const log = console[method] || console.log
      log(...args)
    }

    this._system[method](...args)

    if (this._file) this._file.write(log)
  }
}

module.exports = Hyperlogger

function formatElapsed(ns) {
  const ms = Number(ns) / 1e6
  return ms > 1000 ? `${(ms / 1000).toFixed(3)}s` : `${ms.toFixed(3)}ms`
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
