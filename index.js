const fs = require('fs')
const b4a = require('b4a')
const { Readable } = require('streamx')
const FileLog = require('./lib/file-logger')
const SystemLog = require('#system-logger')
const hrtime = require('#hrtime')
const format = require('#format')
const normaliseAttributes = require('./lib/normalise')
const { createOptions } = normaliseAttributes

const LEVELS = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 }

class Hyperlogger {
  constructor(opts = {}) {
    const {
      dev = false,
      verbose = false,
      file,
      level = 'INFO',
      maxTotalSize,
      maxDepth,
      maxBytes
    } = opts

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

    if (file) this._file = new FileLog(file, { maxSize: maxFileSize })
  }

  static LEVELS = LEVELS

  // logs in write order
  // a stream of every record, oldest first, read one line at a time
  static readLogs(filePath) {
    return Readable.from(records(filePath))
  }

  static parseLogs(rawLogs) {
    const logLines = rawLogs.split('\n')

    const logs = []
    for (const log of logLines) {
      const record = parseRecord(log)
      if (record !== null) logs.push(record)
    }

    return logs
  }

  close() {
    if (this._closed) return

    this._closed = true

    this._timers.clear()
    if (this._file) {
      this._file.close()
      this._file = null
    }
  }

  mute() {
    this._muted = true
  }

  unmute() {
    this._muted = false
  }

  debug(...args) {
    this._write('DEBUG', args)
  }

  verboseDebug(...args) {
    if (!this._verbose) return
    this._write('DEBUG', args)
  }

  info(...args) {
    this._write('INFO', args)
  }

  verboseInfo(...args) {
    if (!this._verbose) return
    this._write('INFO', args)
  }

  warn(...args) {
    this._write('WARN', args)
  }

  error(...args) {
    this._write('ERROR', args)
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

  _write(level, args) {
    if (this._muted || this._closed) return
    if (LEVELS[level] < this._level) return

    // if log attributes have been provided extract them
    let attributes
    if (isPlainObject(args[args.length - 1])) {
      attributes = normaliseAttributes(args.at(-1), this._normaliseOpts)
    }

    let body = ''
    if (attributes) {
      body = args
        .slice(0, -1)
        .map((arg) => format(arg))
        .join(' ')
    } else {
      body = args.map((arg) => format(arg)).join(' ')
    }

    const log = this._buildRecord(level, body, attributes ?? {})
    const method = level.toLowerCase()

    // just for dev purposes
    if (this._dev) {
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

const CHUNK_SIZE = 65_536
const NEWLINE = 0x0a

async function* records(filePath) {
  const files = []

  try {
    for (let i = FileLog.LOG_FILES - 1; i >= 0; i--) {
      let fd
      try {
        fd = fs.openSync(i === 0 ? filePath : `${filePath}.${i}`, 'r')
      } catch (err) {
        if (err.code === 'ENOENT') continue
        throw err
      }

      try {
        files.push({ fd, size: fs.fstatSync(fd).size })
      } catch (err) {
        fs.closeSync(fd)
        throw err
      }
    }

    const chunk = b4a.alloc(CHUNK_SIZE)

    for (const { fd, size } of files) {
      let position = 0

      while (position < size) {
        const read = fs.readSync(fd, chunk, 0, Math.min(CHUNK_SIZE, size - position), position)
        if (read === 0) break

        const data = chunk.subarray(0, read)
        const last = data.lastIndexOf(NEWLINE)

        // handle multi-chunk-sized records
        if (last === -1) {
          const { line, next } = readLongLine(fd, data, position + read, size)
          const record = parseRecord(b4a.toString(line, 'utf8'))

          if (record !== null) yield record
          position = next

          continue
        }

        // yield each record in the chunk
        let start = 0
        while (start <= last) {
          const end = data.indexOf(NEWLINE, start)
          const record = parseRecord(b4a.toString(data.subarray(start, end), 'utf8'))
          if (record !== null) yield record
          start = end + 1
        }

        // carry on from just after the last newline
        position += last + 1
      }
    }
  } finally {
    for (const { fd } of files) fs.closeSync(fd)
  }
}

function readLongLine(fd, first, position, size) {
  const parts = [b4a.from(first)]
  const chunk = b4a.alloc(CHUNK_SIZE)

  while (position < size) {
    const read = fs.readSync(fd, chunk, 0, Math.min(CHUNK_SIZE, size - position), position)
    if (read === 0) break

    const end = chunk.subarray(0, read).indexOf(NEWLINE)
    if (end !== -1) {
      parts.push(b4a.from(chunk.subarray(0, end)))
      return { line: b4a.concat(parts), next: position + end + 1 }
    }

    parts.push(b4a.from(chunk.subarray(0, read)))
    position += read
  }

  return { line: b4a.concat(parts), next: size }
}

function parseRecord(line) {
  if (line.length === 0) return null

  let value
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }

  return isPlainObject(value) ? value : null
}
