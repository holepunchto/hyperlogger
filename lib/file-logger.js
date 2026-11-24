const fs = require('fs')

const DEFAULT_MAX_FILE_SIZE = 10_485_760 // 10MB
const REOPEN_RETRY_INTERVAL = 1000 // ms between attempts while the file can't be opened

/**
 * a stripped-down version of bare-file-logger that outputs JSON
 * logs to a file.
 */
class FileLog {
  constructor(path, opts = {}) {
    const { maxSize = DEFAULT_MAX_FILE_SIZE } = opts

    this._path = path
    this._maxSize = maxSize
    this._closed = false
    this._retryAt = 0

    this._fd = fs.openSync(this._path, 'a+')

    try {
      this._size = fs.fstatSync(this._fd).size
    } catch (err) {
      fs.closeSync(this._fd)
      throw err
    }

    this._gc()
  }

  static LOG_FILES = 10

  write(log) {
    if (this._fd === -1 && !this._retryReopen()) return

    try {
      const logStr = JSON.stringify(log) + '\n'
      this._size += fs.writeSync(this._fd, logStr, { encoding: 'utf8' })

      // rotate files when size grows too large
      if (this._size > this._maxSize) this._gc()
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
      if (this._maxSize <= 0 || this._size < this._maxSize) return

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
      fs.unlinkSync(`${this._path}.${FileLog.LOG_FILES - 1}`)
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

  // Every (re)open resets _size from the real file, so after a rotation the count
  // starts again from the new, empty file instead of the old total.
  _reopen() {
    if (this._closed) return false
    if (this._fd !== -1) return true

    try {
      const fd = fs.openSync(this._path, 'a+')

      try {
        this._size = fs.fstatSync(fd).size
      } catch (err) {
        // something has gone badly wrong
        fs.closeSync(fd)
        throw err
      }

      this._fd = fd
      return true
    } catch {
      return false
    }
  }

  // With no timer, nothing else retries after a failed reopen, so write does it,
  // at most once per REOPEN_RETRY_INTERVAL so a broken folder doesn't cost a
  // failed open on every line.
  _retryReopen() {
    if (Date.now() < this._retryAt) return false
    if (this._reopen()) return true

    this._retryAt = Date.now() + REOPEN_RETRY_INTERVAL
    return false
  }
}

module.exports = FileLog
