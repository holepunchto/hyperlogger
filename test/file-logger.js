const test = require('brittle')
const fs = require('fs')
const path = require('path')
const FileLog = require('../lib/file-logger')

test('file-logger - 10 trailing log files are created correctly', async (t) => {
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

  const log = new FileLog(filePath, { maxSize: 128, rotateInterval: 19 })

  for (let i = 0; i < 10; i++) {
    log.write(testLog)
    await new Promise((resolve) => setTimeout(resolve, 20))
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

// Swap an fs function for the length of one test
function stub(t, name, fn) {
  const original = fs[name]

  fs[name] = fn

  t.teardown(() => {
    fs[name] = original
  })

  return original
}

const fail = (code) => () => {
  const err = new Error(code)
  err.code = code

  throw err
}

async function setup(t, opts = {}) {
  const dir = await t.tmp()
  const file = path.join(dir, 'app.log')

  const log = new FileLog(file, { maxSize: 10, rotateInterval: 60_000, ...opts })

  t.teardown(() => log.close())

  return { file, log }
}

test('file-logger - a failed rotation does not throw and logging carries on', async (t) => {
  const { file, log } = await setup(t)
  log.write({ body: 'fills past maxSize' })

  stub(t, 'renameSync', fail('EACCES')) // e.g. the folder became read-only

  t.execution(() => log._gc(), 'rotation failure is swallowed')
  t.not(log._fd, -1, 'still has a file to write to')

  log.write({ body: 'after the failure' })
  t.ok(
    fs.readFileSync(file, 'utf8').includes('after the failure'),
    'kept appending to the same file'
  )
})

test('file-logger - recovers once the file can be opened again', async (t) => {
  const { file, log } = await setup(t)
  log.write({ body: 'fills past maxSize' })

  const openSync = stub(t, 'openSync', fail('EACCES'))
  log._gc()
  t.is(log._fd, -1, 'reopen failed, so there is no handle')
  t.execution(() => log.write({ body: 'dropped' }), 'writing with no handle does not throw')

  fs.openSync = openSync
  log._gc()
  t.not(log._fd, -1, 'next tick reopened the file')

  log.write({ body: 'back again' })
  t.ok(fs.readFileSync(file, 'utf8').includes('back again'), 'can append to the opened file')
})

test('file-logger - closing after a failure never reopens the file', async (t) => {
  const { log } = await setup(t)
  log.write({ body: 'fills past maxSize' })

  const openSync = stub(t, 'openSync', fail('EACCES'))
  log._gc()
  t.is(log._fd, -1)

  log.close()
  t.is(log._interval, null, 'timer cleared even though there was no handle')

  fs.openSync = openSync
  log._gc()
  t.is(log._fd, -1, 'a closed logger stays closed')
  t.is(log._reopen(), false)
})

test('file-logger - never holds more than one handle', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'app.log')

  let open = 0
  let most = 0
  const openSync = stub(t, 'openSync', (...args) => {
    const fd = openSync(...args)
    most = Math.max(most, ++open)
    return fd
  })
  const closeSync = stub(t, 'closeSync', (fd) => {
    closeSync(fd)
    open--
  })

  const log = new FileLog(file, { maxSize: 10, rotateInterval: 60_000 })

  for (let i = 0; i < 25; i++) {
    log.write({ body: 'fills past maxSize ' + i })
    log._gc() // a successful rotation
  }

  fs.renameSync = fail('EACCES')
  log.write({ body: 'fills past maxSize' })
  log._gc() // a failed rotation
  log._reopen() // calling it while a handle is open must not open another
  log.clear()

  t.is(open, 1, 'one handle while running')

  log.close()
  log.close()
  log.clear()
  log._gc()

  t.is(open, 0, 'none after close')
  t.is(most, 1, 'never more than one at any point')
})
