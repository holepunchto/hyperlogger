const test = require('brittle')
const fs = require('fs')
const path = require('path')
const Hyperlogger = require('../index.js')

test('check all standard log types produce outputs', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'logs')
  const logger = new Hyperlogger({ level: 'DEBUG', file })

  t.teardown(() => logger._file.close())

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
  t.teardown(() => logger._file.close())
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

  t.teardown(() => logger._file.close())

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

  t.teardown(() => logger._file.close())

  logger.info('x', Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['k' + i, i])))

  const [log] = Hyperlogger.parseLogs(fs.readFileSync(file, { encoding: 'utf8' }))
  t.alike(log.attributes, { k0: 0, k1: 1, k2: 2, k3: 3, '...': '96 more keys' })
})
