const test = require('brittle')
const fs = require('fs')
const path = require('path')
const FileLog = require('../lib/file-logger')

const RETRY_INTERVAL = 1000 // REOPEN_RETRY_INTERVAL in lib/file-logger.js
const ROTATE_RETRY_INTERVAL = 1000 // ROTATE_RETRY_INTERVAL in lib/file-logger.js

// longer than setup's 40-byte maxSize on its own, so writing it rotates; short lines don't
const BIG = { body: 'fills past maxSize'.padEnd(60, '.') }

test('file-logger - rotation keeps the live file plus 9 older ones', async (t) => {
  const dir = await t.tmp()
  const file = 'test-file.json'
  const filePath = path.join(dir, file)

  const testLog = {
    timeUnixNano: '0',
    observedTimeUnixNano: '0',
    severityNumber: 5,
    severityText: 'INFO',
    body: 'this is a test log to see if new files can be made',
    attributes: {
      some: 'attribute information'
    }
  }

  // each line is bigger than maxSize, so every write rotates
  const log = new FileLog(filePath, { maxSize: 128 })
  t.teardown(() => log.close())

  for (let i = 0; i < 12; i++) {
    log.write(testLog)
  }

  const logFiles = fs.readdirSync(dir)

  t.is(logFiles.length, 10, 'the correct number of log files have been created')

  const expectedNames = [...Array(10).keys()].slice(1).map((idx) => file + '.' + idx)
  expectedNames.push(file)

  t.alike(
    logFiles.toSorted(),
    expectedNames.toSorted(),
    'the log file names match the expected names'
  )
})

test('file-logger - rotation keeps every line, in order, with the right number per file', async (t) => {
  const lineSize = line(0).length
  // rotation happens once the file goes over maxSize, so this fits exactly 6 lines
  const { file, log } = await setup(t, { maxSize: 6 * lineSize - 1 })

  for (let i = 0; i < 30; i++) log.write(record(i))

  for (let i = 1; i <= 5; i++) t.is(lines(`${file}.${i}`).length, 6, `.${i} holds 6 lines`)
  t.is(lines(file).length, 0, 'the live file is empty, having just rotated')
  t.is(fs.existsSync(`${file}.6`), false, 'no more files than needed')

  t.alike(
    readAll(file),
    Array.from({ length: 30 }, (_, i) => line(i).trimEnd()),
    'every line is kept, oldest file first'
  )
})

test('file-logger - the size count matches the real file', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'app.log')
  fs.writeFileSync(file, 'x'.repeat(100) + '\n')

  const log = new FileLog(file, { maxSize: 1000 })
  t.teardown(() => log.close())
  t.is(log._size, 101, 'starts from the existing file size')

  for (let i = 0; i < 10; i++) log.write(record(i))
  t.is(log._size, fs.statSync(file).size, 'after writes')

  // crosses maxSize and rotates at least once
  for (let i = 10; i < 40; i++) log.write(record(i))

  t.ok(fs.existsSync(`${file}.1`), 'a rotation happened')
  t.is(log._size, fs.statSync(file).size, 'recorded file size is accurate after a rotation')

  log.clear()
  t.is(log._size, 0, 'recorded file size is zero after being cleared')
  t.is(log._size, fs.statSync(file).size, 'recorded and actual file size agree after clear')

  log.write(record(0))
  t.is(log._size, fs.statSync(file).size, 'recorded file size is accurate when writing after clear')
})

test('file-logger - rotates once the file goes over maxSize, not when it reaches it', async (t) => {
  const lineSize = line(0).length

  const exact = await setup(t, { maxSize: 2 * lineSize })
  exact.log.write(record(0))
  exact.log.write(record(1))
  t.is(fs.existsSync(`${exact.file}.1`), false, 'landing exactly on maxSize does not rotate')
  t.is(lines(exact.file).length, 2)

  exact.log.write(record(2))
  t.is(lines(`${exact.file}.1`).length, 3, 'the next write goes over and rotates')

  const over = await setup(t, { maxSize: 2 * lineSize - 1 })
  over.log.write(record(0))
  over.log.write(record(1))
  t.is(lines(`${over.file}.1`).length, 2, 'one byte over maxSize rotates')
})

test('file-logger - a failed rotation does not throw and logging carries on', async (t) => {
  const { file, log } = await setup(t)

  // the folder becomes read-only
  stubfs(t, 'renameSync', fail('EACCES'))

  t.execution(() => log.write(BIG), 'rotation failure is swallowed')
  t.not(log._fd, -1, 'still has a file to write to')
  t.is(fs.existsSync(`${file}.1`), false, 'nothing was rotated')

  log.write({ body: 'after the failure' })
  t.ok(
    fs.readFileSync(file, 'utf8').includes('after the failure'),
    'kept appending to the same file'
  )
})

test('file-logger - writes reopen the file once it can be opened again', async (t) => {
  const { file, log } = await setup(t)
  const time = clock(t)

  const openSync = stubfs(t, 'openSync', fail('EACCES'))

  // rotates, then the reopen fails
  log.write(BIG)

  t.is(log._fd, -1, 'reopen failed, so there is no handle')
  t.execution(() => log.write({ body: 'dropped' }), 'writing with no handle does not throw')

  fs.openSync = openSync
  log.write({ body: 'too soon' })
  t.is(log._fd, -1, 'still waiting out the retry interval')

  time.advance(RETRY_INTERVAL)

  log.write({ body: 'back again' })

  t.not(log._fd, -1, 'a write after the interval reopened the file')
  t.ok(contents(file).includes('back again'), 'can append to the reopened file')
  t.absent(contents(file).includes('too soon'), 'lines with no handle were dropped')
})

test('file-logger - reopen attempts are limited to one per retry interval', async (t) => {
  const { log } = await setup(t)
  const time = clock(t)

  let attempts = 0
  stubfs(t, 'openSync', () => {
    attempts++
    fail('EACCES')()
  })

  // reopen on rotation fails
  log.write(BIG)
  t.is(log._fd, -1)

  const before = attempts
  for (let i = 0; i < 100; i++) log.write({ body: 'dropped ' + i })
  t.is(attempts, before + 1, 'one attempt for 100 writes inside one interval')

  // retry just before interval fails
  time.advance(RETRY_INTERVAL - 1)
  log.write({ body: 'still inside the interval' })
  t.is(attempts, before + 1, 'no attempt just before the interval ends')

  time.advance(1)
  for (let i = 0; i < 100; i++) log.write({ body: 'next interval ' + i })
  t.is(attempts, before + 2, 'one more attempt in the next interval')
})

test('file-logger - a closed logger never reopens, even after a failure', async (t) => {
  const { log } = await setup(t)
  const time = clock(t)

  const openSync = stubfs(t, 'openSync', fail('EACCES'))
  log.write(BIG)
  t.is(log._fd, -1)

  log.close()

  let opens = 0
  fs.openSync = (...args) => {
    opens++
    return openSync(...args)
  }

  // everything that could reopen the file: writing past the retry interval, and clear
  time.advance(RETRY_INTERVAL)
  log.write({ body: 'after close' })
  log.clear()
  time.advance(RETRY_INTERVAL)
  log.write(BIG)

  t.is(log._fd, -1, 'a closed logger stays closed')
  t.is(opens, 0, 'nothing tried to open the file')
})

test('file-logger - writing after close does nothing', async (t) => {
  const { file, log } = await setup(t, { maxSize: 1000 })
  const time = clock(t)

  log.write({ body: 'before close' })
  const contents = fs.readFileSync(file, 'utf8')
  log.close()

  let opens = 0
  const openSync = stubfs(t, 'openSync', (...args) => {
    opens++
    return openSync(...args)
  })

  log.write({ body: 'after close' })
  time.advance(RETRY_INTERVAL)
  log.write({ body: 'after close, past the retry interval' })

  t.is(opens, 0, 'no file was opened')
  t.is(fs.readFileSync(file, 'utf8'), contents, 'the file is unchanged')
})

test('file-logger - a failing fstat on reopen prevents file being opened', async (t) => {
  let open = 0

  const openSync = stubfs(t, 'openSync', (...args) => {
    open++
    return openSync(...args)
  })
  const closeSync = stubfs(t, 'closeSync', (fd) => {
    open--
    return closeSync(fd)
  })

  const { file, log } = await setup(t)

  // reopen can't read the new file size
  stubfs(t, 'fstatSync', fail('EIO'))
  log.write(BIG)

  t.is(log._fd, -1, 'the reopen fails')
  t.is(open, 0, 'there are no open files')

  log.write({ body: 'after the reopen' })
  t.ok(
    fs.readFileSync(`${file}.1`, 'utf8').includes('fills past maxSize'),
    'first line was rotated'
  )
  t.ok(!fs.readFileSync(file, 'utf8').includes('after the reopen'), 'did not write to the new file')
})

test('file-logger - never holds more than one handle', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'app.log')

  let open = 0
  let most = 0
  const openSync = stubfs(t, 'openSync', (...args) => {
    const fd = openSync(...args)
    most = Math.max(most, ++open)
    return fd
  })
  const closeSync = stubfs(t, 'closeSync', (fd) => {
    closeSync(fd)
    open--
  })

  const log = new FileLog(file, { maxSize: 10 })

  for (let i = 0; i < 25; i++) log.write({ body: 'fills past maxSize ' + i }) // each one rotates

  stubfs(t, 'renameSync', fail('EACCES'))
  log.write({ body: 'fills past maxSize' }) // a failed rotation
  log.write({ body: 'fills past maxSize' }) // over the limit again while the handle is open
  log.clear()

  t.is(open, 1, 'one handle while running')

  log.close()
  log.close()
  log.clear()
  log.write({ body: 'after close' })

  t.is(open, 0, 'none after close')
  t.is(most, 1, 'never more than one at any point')
})

test('file-logger - rotation recovers after failures without losing any lines', async (t) => {
  const { file, log } = await setup(t, { maxSize: 6 * line(0).length - 1 }) // 6 lines per file
  const time = clock(t)
  const pending = `${file}.rotating`

  let next = 0
  const write = (count) => {
    for (let i = 0; i < count; i++) log.write(record(next++))
  }
  const expected = (count) => Array.from({ length: count }, (_, i) => line(i).trimEnd())

  // standard rotation works normally
  {
    write(6)
    t.alike(lines(`${file}.1`), expected(6))
  }

  // prevent live renaming
  const renameSync = stubfs(t, 'renameSync', (from, to) => {
    if (from === file) fail('EPERM')()
    return renameSync(from, to)
  })

  // live takes all new lines
  {
    write(10)
    t.alike(lines(`${file}.1`), expected(6), 'history is untouched')
    t.is(lines(file).length, 10, 'the new lines stay in app.log')
  }

  // cannot rename rotation file
  let failOnce = true
  fs.renameSync = (from, to) => {
    if (from === pending && failOnce) {
      failOnce = false
      fail('EPERM')()
    }
    return renameSync(from, to)
  }

  time.advance(ROTATE_RETRY_INTERVAL)

  // rotation stops partway, live accepts new writes
  {
    write(1)
    t.ok(fs.existsSync(pending), 'rotation stopped part-way, with the old live file in .rotating')
    t.is(lines(`${file}.2`).length, 6, 'the .1 file has been moved to .2')

    write(9)
    t.alike(lines(pending).length, 11, 'pending still has 11 lines')
    t.is(lines(file).length, 9, 'the newly appended lines remain in the live log')
  }

  // rotation works
  fs.renameSync = renameSync
  time.advance(ROTATE_RETRY_INTERVAL)

  // log files move to fill gaps, no logs are lost
  // logs remain in order
  {
    write(1)
    t.ok(!fs.existsSync(pending), 'the pending file no longer exists')
    t.is(lines(file).length, 0, 'the live file is empty after rotation')
    t.is(lines(`${file}.1`).length, 10, 'live has been moved to .1')
    t.is(lines(`${file}.2`).length, 11, 'pending has been moved to .2')
    t.is(lines(`${file}.3`).length, 6, '.2 has been moved to .3')

    t.alike(readAll(file), expected(next), 'every line is kept, in order')
  }
})

test('file-logger - a failed rotation is retried at most once per interval', async (t) => {
  const { log } = await setup(t, { maxSize: 6 * line(0).length - 1 }) // 6 lines per file
  const time = clock(t)

  let attempts = 0
  stubfs(t, 'renameSync', () => {
    attempts++
    fail('EPERM')()
  })

  for (let i = 0; i < 6; i++) log.write(record(i)) // reaches the limit
  t.is(attempts, 1, 'the first attempt happens straight away')

  for (let i = 0; i < 20; i++) log.write(record(i))
  t.is(attempts, 1, 'no further attempts within the interval')

  time.advance(ROTATE_RETRY_INTERVAL - 1)
  log.write(record(0))
  t.is(attempts, 1, 'none just before the interval ends')

  time.advance(1)
  log.write(record(0))
  t.is(attempts, 2, 'one more once the interval has passed')
})

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
function clock(t) {
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
