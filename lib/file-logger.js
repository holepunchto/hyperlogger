const fs = require('fs')

const DEFAULT_MAX_FILE_SIZE = 10_485_760 // 10MB
const FS_RETRY_INTERVAL = 1000 // ms between attempts at using the file system

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

    this._fd = fs.openSync(this._path, 'a')

    try {
      this._size = fs.fstatSync(this._fd).size
    } catch (err) {
      fs.closeSync(this._fd)
      throw err
    }

    // tidies old rotation crash
    try {
      if (fs.existsSync(this._pending())) this._shiftInto(this._pending())
    } catch {}

    this._rotateIfNeeded()
  }

  static LOG_FILES = 10

  write(log) {
    if (this._fd === -1 && !this._retryReopen()) return

    const logStr = JSON.stringify(log) + '\n'
    this._size += fs.writeSync(this._fd, logStr)

    // rotate files when size grows too large
    if (this._size > this._maxSize) this._rotateIfNeeded()
  }

  close() {
    this._closed = true

    if (this._fd === -1) return

    fs.closeSync(this._fd)

    this._fd = -1
  }

  _rotateIfNeeded() {
    if (this._closed) return
    if (this._fd === -1 && !this._reopen()) return

    if (this._maxSize <= 0 || this._size < this._maxSize) return

    // continue appending to live if rotation failed
    if (Date.now() < this._retryAt) return

    try {
      fs.closeSync(this._fd)
      this._fd = -1

      this._rotate()
    } catch {
      this._retryAt = Date.now() + FS_RETRY_INTERVAL
    }

    this._reopen()
  }

  _rotate() {
    const pending = this._pending()

    if (fs.existsSync(pending)) this._shiftInto(pending)

    fs.renameSync(this._path, pending)
    this._shiftInto(pending)
  }

  _shiftInto(from) {
    const name = (i) => `${this._path}.${i}`
    const last = FileLog.LOG_FILES - 1

    // find the closest gap
    let free = 1
    while (free <= last && fs.existsSync(name(free))) free++

    if (free > last) {
      fs.unlinkSync(name(last))
      free = last
    }

    // move to fill up to gap
    for (let i = free; i > 1; i--) fs.renameSync(name(i - 1), name(i))

    fs.renameSync(from, name(1))
  }

  _pending() {
    return `${this._path}.rotating`
  }

  _reopen() {
    if (this._closed) return false
    if (this._fd !== -1) return true

    try {
      const fd = fs.openSync(this._path, 'a+')

      try {
        this._size = fs.fstatSync(fd).size
      } catch (err) {
        fs.closeSync(fd)
        throw err
      }

      this._fd = fd
      return true
    } catch {
      return false
    }
  }

  // used by write if this._file doesn't exist
  _retryReopen() {
    if (Date.now() < this._retryAt) return false
    if (this._reopen()) return true

    this._retryAt = Date.now() + FS_RETRY_INTERVAL
    return false
  }
}

module.exports = FileLog
