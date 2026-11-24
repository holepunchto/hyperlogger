const test = require('brittle')
const fs = require('fs')
const path = require('path')
const FileLog = require('../lib/file-logger')

test('file-logger - 10 trailing log files are created correctly', async (t) => {
  const dir = await t.tmp()
  const file = 'test-file.json'
  const filePath = path.join(dir, file)

  const log = {
    timeUnixNano: '0',
    observedTimeUnixNano: '0',
    severityNumber: 5,
    severityText: 'INFO',
    body: 'this is a test log to see if new files can be made',
    attributes: {
      some: 'attribute information'
    }
  }

  const fileLog = new FileLog(filePath, { maxSize: 128, rotateInterval: 19 })

  for (let i = 0; i < 10; i++) {
    fileLog.write(log)
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
