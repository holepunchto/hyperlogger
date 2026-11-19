const EventEmitter = require('bare-events')
const fs = require('fs')

/**
 * A stripped-down version of bare-file-logger that outputs JSON
 * logs to a file.
 */
class FileLog extends EventEmitter {
  constructor(path, opts = {}) {
    const { maxSize = 0, rotate = null, rotateInterval = 2000 } = opts

    super()

    this._path = path
    this._maxSize = maxSize
    this._rotate = rotate

    this._interval = setInterval(this._gc.bind(this), rotateInterval)
    this._interval.unref()

    this._fd = fs.openSync(this._path, 'a+')
    this._gc()
  }

  write(log) {
    try {
      const logStr = JSON.stringify(log) + '\n'
      fs.writeSync(this._fd, logStr, { encoding: 'utf8' })
    } catch (err) {
      console.log(err)
    }
  }

  clear() {
    // Truncate by path rather than on the append fd. On Windows an 'a+' handle
    // only has FILE_APPEND_DATA, so ftruncate on it fails with EPERM.
    fs.closeSync(this._fd)
    this._fd = -1
    fs.truncateSync(this._path, 0)

    this._fd = fs.openSync(this._path, 'a+')
  }

  close() {
    if (this._fd === -1) return

    if (this._interval) clearInterval(this._interval)

    fs.closeSync(this._fd)

    this._fd = -1
    this._interval = null
  }

  [Symbol.dispose]() {
    this.close()
  }

  _gc() {
    if (this._fd === -1 || this._maxSize <= 0 || fs.fstatSync(this._fd).size < this._maxSize) return

    let archived
    try {
      archived = this._rotate && this._rotate(this._path)
    } catch {
      archived = null
    }

    if (this._fd === -1) return

    fs.closeSync(this._fd)
    this._fd = -1

    // Truncate by path rather than on the append fd. On Windows an 'a+' handle
    // only has FILE_APPEND_DATA, so ftruncate on it fails with EPERM.
    if (archived) fs.renameSync(this._path, archived)
    else fs.truncateSync(this._path, 0)

    this._fd = fs.openSync(this._path, 'a+')

    this.emit('rotate', this._path, archived)
  }
}

module.exports = FileLog
