const fs = require('fs')

const DEFAULT_MAX_FILE_SIZE = 10_485_760 // 10MB

/**
 * a stripped-down version of bare-file-logger that outputs JSON
 * logs to a file.
 */
class FileLog {
  constructor(path, opts = {}) {
    const { maxSize = DEFAULT_MAX_FILE_SIZE, rotateInterval = 2000 } = opts

    this._path = path
    this._maxSize = maxSize
    this._closed = false

    this._fd = fs.openSync(this._path, 'a+')

    this._interval = setInterval(this._gc.bind(this), rotateInterval)
    this._interval.unref()

    this._gc()
  }

  static LOG_FILES = 10

  write(log) {
    if (this._fd === -1) return

    try {
      const logStr = JSON.stringify(log) + '\n'
      fs.writeSync(this._fd, logStr, { encoding: 'utf8' })
    } catch (err) {
      console.error(err)
    }
  }

  clear() {
    if (this._closed || this._fd === -1) return

    // truncate by path rather than on the append fd. On Windows an 'a+' handle
    // only has FILE_APPEND_DATA, so ftruncate on it fails with EPERM.
    fs.closeSync(this._fd)
    this._fd = -1

    try {
      fs.truncateSync(this._path, 0)
    } finally {
      this._reopen() // ensure logging continues
    }
  }

  close() {
    this._closed = true

    if (this._interval) clearInterval(this._interval)
    this._interval = null

    if (this._fd === -1) return

    fs.closeSync(this._fd)

    this._fd = -1
  }

  [Symbol.dispose]() {
    this.close()
  }

  // If rotation fails (read-only folder, file held open on Windows, ...)
  // append to the same file and try again on the next tick.
  _gc() {
    if (this._closed) return
    if (this._fd === -1 && !this._reopen()) return // a past failure: retry the open

    try {
      if (this._maxSize <= 0 || fs.fstatSync(this._fd).size < this._maxSize) return

      fs.closeSync(this._fd)
      this._fd = -1

      this._rotate()
    } catch {
      // fall through and reopen whatever is at the path
    }

    this._reopen()
  }

  _rotate() {
    // delete the oldest log
    try {
      fs.unlinkSync(`${this._path}.9`)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }

    // promote logs up the chain
    for (let i = FileLog.LOG_FILES - 1; i > 0; i--) {
      try {
        if (i === 1) fs.renameSync(this._path, `${this._path}.1`)
        else fs.renameSync(`${this._path}.${i - 1}`, `${this._path}.${i}`)
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }
  }

  _reopen() {
    if (this._closed) return false
    if (this._fd !== -1) return true

    try {
      this._fd = fs.openSync(this._path, 'a+')
      return true
    } catch {
      return false
    }
  }
}

module.exports = FileLog
