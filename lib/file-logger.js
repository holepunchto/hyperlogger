const fs = require('fs')

const DEFAULT_MAX_FILE_SIZE = 10_485_760

/**
 * a stripped-down version of bare-file-logger that outputs JSON
 * logs to a file.
 */
class FileLog {
  constructor(path, opts = {}) {
    const { maxSize = DEFAULT_MAX_FILE_SIZE, rotateInterval = 2000 } = opts

    this._path = path
    this._maxSize = maxSize

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
      console.error(err)
    }
  }

  clear() {
    if (this._fd === -1) return

    // truncate by path rather than on the append fd. On Windows an 'a+' handle
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

    fs.closeSync(this._fd)
    this._fd = -1

    // delete the oldest log
    try {
      fs.unlinkSync(`${this._path}.9`)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }

    // promote logs up the chain
    for (let i = 9; i > 0; i--) {
      try {
        if (i === 1) fs.renameSync(this._path, `${this._path}.1`)
        else fs.renameSync(`${this._path}.${i - 1}`, `${this._path}.${i}`)
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }

    this._fd = fs.openSync(this._path, 'a+')
  }
}

module.exports = FileLog
