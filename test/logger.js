const test = require('brittle')
const fs = require('fs')
const path = require('path')
const Hyperlogger = require('../index')

test('check all standard log types produce outputs', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'logs')
  const logger = new Hyperlogger({ level: 'DEBUG', file })

  t.teardown(() => logger.close())

  const msg1 = 'hi'
  const msg2 = 'there'
  const attr = { test: 'success' }

  logger.debug(msg1, msg2, attr)
  logger.info(msg1, msg2, attr)
  logger.warn(msg1, msg2, attr)
  logger.error(msg1, msg2, attr)

  const rawLogs = fs.readFileSync(file, { encoding: 'utf8' })
  const logs = Hyperlogger.parseLogs(rawLogs)

  const expectedLogs = ['DEBUG', 'INFO', 'WARN', 'ERROR'].map((level) => ({
    timeUnixNano: '0',
    observedTimeUnixNano: '0',
    severityNumber: Hyperlogger.LEVELS[level],
    severityText: level,
    body: `${msg1} ${msg2}`,
    attributes: attr
  }))

  // Timestamps vary between calls; compare the remaining fields.
  const withoutTimestamps = ({ timeUnixNano, observedTimeUnixNano, ...log }) => log
  t.alike(
    logs.map(withoutTimestamps),
    expectedLogs.map(withoutTimestamps),
    'expected logs match actual logs'
  )
})

test('logger serializes normalized attributes without mutating the input', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'logs')
  const logger = new Hyperlogger({ file })
  t.teardown(() => logger.close())
  logger._system.info = () => {}

  const attrs = { count: 42n, date: new Date('2026-01-01T00:00:00Z') }
  attrs.self = attrs
  Object.defineProperty(attrs, 'broken', {
    enumerable: true,
    get() {
      throw new Error('cannot read attribute')
    }
  })

  logger.info('normalized', attrs)

  const logs = Hyperlogger.parseLogs(fs.readFileSync(file, 'utf8'))
  t.is(logs.length, 1)
  t.alike(logs[0].attributes, {
    count: '42',
    date: '2026-01-01T00:00:00.000Z',
    self: '[Circular]',
    broken: '[Unserializable]'
  })
  t.is(attrs.count, 42n)
  t.is(attrs.self, attrs)
})

test('timing log output is JSON with timing in the log body', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'logs')
  const logger = new Hyperlogger({ file })

  t.teardown(() => logger.close())

  const label = 'test'

  logger.time(label)
  logger.timeLog(label, 'this is a test', { test: 'success' })
  logger.timeEnd(label, { test: 'end' })

  const rawLogs = fs.readFileSync(file, { encoding: 'utf8' })
  const logs = Hyperlogger.parseLogs(rawLogs)

  const withoutTimestamps = ({ timeUnixNano, observedTimeUnixNano, ...log }) => log
  const timingLogs = logs.map(withoutTimestamps)

  t.alike(
    timingLogs.map(({ body, ...fields }) => fields),
    [
      {
        severityNumber: Hyperlogger.LEVELS.INFO,
        severityText: 'INFO',
        attributes: { test: 'success' }
      },
      { severityNumber: Hyperlogger.LEVELS.INFO, severityText: 'INFO', attributes: { test: 'end' } }
    ],
    'timing logs contain exactly the expected fields apart from timestamps and body'
  )
  t.ok(
    /^test: \d+\.\d{3}(?:ms|s) this is a test$/.test(timingLogs[0]?.body),
    'timeLog body contains the label, formatted duration and message'
  )
  t.ok(
    /^test: \d+\.\d{3}(?:ms|s)$/.test(timingLogs[1]?.body),
    'timeEnd body contains only the label and formatted duration'
  )
})

test('logger passes maxBytes through to the attributes', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'logs')
  const logger = new Hyperlogger({ file, maxBytes: 50 })

  t.teardown(() => logger.close())

  logger.info('x', Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['k' + i, i])))

  const [log] = Hyperlogger.parseLogs(fs.readFileSync(file, { encoding: 'utf8' }))
  t.alike(log.attributes, { k0: 0, k1: 1, k2: 2, k3: 3, '...': '96 more keys' })
})

test('loggers sharing a path never rotate the file out from under each other', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'app.log')
  const LOGGERS = 10
  const ROUNDS = 7

  // Records are identical, so every line is `size` bytes
  const body = (logger, n) =>
    `logger ${String(logger).padStart(2, '0')} line ${String(n).padStart(4, '0')}`
  const attributes = (n) => ({ n: String(n).padStart(4, '0') })
  const exampleRecord = {
    timeUnixNano: '0'.repeat(19),
    observedTimeUnixNano: '0'.repeat(19),
    severityNumber: Hyperlogger.LEVELS.INFO,
    severityText: 'INFO',
    body: body(0, 0),
    attributes: attributes(0)
  }
  const size = JSON.stringify(exampleRecord).length + 1

  // a file rotates once it goes over maxSize.
  // so 6 * size - 1 holds exactly 6 lines;
  const perFile = 6
  const maxTotalSize = 10 * (perFile * size - 1)

  const loggers = []
  for (let i = 0; i < LOGGERS; i++) {
    const logger = new Hyperlogger({ file, maxTotalSize })
    t.teardown(() => logger.close())
    loggers.push(logger)
  }

  t.is(new Set(loggers.map((l) => l._file)).size, 1, 'all loggers share one writer')

  // loggers take turns writing lines
  for (let r = 0; r < ROUNDS; r++) {
    for (let i = 0; i < LOGGERS; i++) {
      const n = r * LOGGERS + i
      loggers[i].info(body(i, n), attributes(n))
    }
  }

  // 70 lines written in total, causing 11 rotations at 6 per file:
  // lines 0 to 11 are deleted, and there are 4 lines in the live file
  const total = LOGGERS * ROUNDS
  const rotations = Math.floor(total / perFile)
  const live = total % perFile
  const firstKept = (rotations - 9) * perFile

  const expectedNames = ['app.log', ...Array.from({ length: 9 }, (_, i) => `app.log.${i + 1}`)]
  t.alike(
    fs.readdirSync(dir).toSorted(),
    expectedNames.toSorted(),
    'the live file plus 9 older ones'
  )

  for (let i = 1; i <= 9; i++) {
    t.is(readLines(`${file}.${i}`).length, perFile, `app.log.${i} holds ${perFile} lines`)
  }
  t.is(readLines(file).length, live, `app.log holds the last ${live} lines`)

  const all = readAll(file)

  const expected = []
  for (let n = firstKept; n < total; n++) {
    expected.push({ body: body(n % LOGGERS, n), attributes: attributes(n) })
  }

  t.alike(
    all.map(({ body, attributes }) => ({ body, attributes })),
    expected,
    `lines ${firstKept} to ${total - 1}, in order, each from the logger that wrote it`
  )

  const lengths = new Set()
  for (const name of fs.readdirSync(dir)) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean)) {
      lengths.add(line.length + 1)
    }
  }
  t.alike([...lengths], [size], 'every line in every file is the expected fixed length')
})

test('logger formats errors to show message and code', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'logs')
  const logger = new Hyperlogger({ file, maxBytes: 50 })

  t.teardown(() => logger.close())

  logger.error('failed', new Error('boom'))

  const [log] = Hyperlogger.readLogs(file)
  t.ok(log.body.includes('failed Error: boom'), 'contains standard error message')
  t.ok(log.body.includes('at async Test._run'), 'stack trace references the brittle index')
})

// read all logs in write order
function readAll(file) {
  const all = []
  for (let i = 9; i >= 1; i--) all.push(...readLines(`${file}.${i}`))
  all.push(...readLines(file))

  return all
}

function readLines(file) {
  if (!fs.existsSync(file)) return []
  return Hyperlogger.parseLogs(fs.readFileSync(file, 'utf8'))
}
