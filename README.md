# Hyperlogger

A small logger for Node.js and Bare, with structured JSON file output, log levels and labelled timers.

Bare also writes messages to the native system logger. In Node.js, the system logger is a no-op; use file logging or enable the development console output.

## Install

```sh
npm install hyperlogger
```

## Usage

```js
const { Hyperlogger } = require('hyperlogger')

const logger = new Hyperlogger({
  logFile: './app.log',
  logLevel: 'DEBUG'
})

logger.info('Starting download', { file: 'example.txt' })

logger.time('download')
// Perform the download...
logger.timeEnd('download', { file: 'example.txt' })
```

## API

#### `const logger = new Hyperlogger([options])`

Create a logger. Options include:

```js
{
  logLevel: 'INFO', // minimum severity, case insensitive
  logFile: undefined, // optional path for newline-delimited JSON logs
  logFileMaxSize: 100_000_000, // file size limit in bytes; clears the file when reached
  dev: false, // also print messages to the console when logLevel is DEBUG
  verbose: false // enable verboseDebug and verboseInfo
}
```

Without `logFile`, no file is written. In Node.js, without development console output or a log file, logging produces no output.

#### `logger.debug(...args)`

#### `logger.info(...args)`

#### `logger.warn(...args)`

#### `logger.error(...args)`

Log a message at the corresponding severity. Messages below `logLevel` are ignored.

Arguments are joined with spaces to form the message. A final plain object is treated as structured attributes and stored separately in the file output.

```js
logger.info('Connected to', 'peer', { peerId: 'abc' })
```

File records contain `timeUnixNano`, `observedTimeUnixNano`, `severityNumber`, `severityText`, `body` and `attributes`. Timestamps are epoch nanoseconds encoded as decimal strings, with millisecond precision.

Attributes are normalised into JSON-safe values. Dates become ISO strings, bigints become decimal strings, and circular references become placeholders. Maps, Sets and binary values become console-style previews, limited to 32 entries or bytes.

#### `logger.verboseDebug(...args)`

#### `logger.verboseInfo(...args)`

Log only when `verbose` is enabled. The usual severity filtering still applies.

#### `logger.time(label)`

Start a timer, replacing any existing timer with the same label.

#### `logger.timeLog(label, ...args)`

Log the elapsed time at INFO severity, followed by any additional message arguments and attributes. Keeps the timer running.

#### `logger.timeEnd(label, ...args)`

Log the elapsed time and remove the timer. Durations are formatted in milliseconds or seconds. Unknown timer labels are ignored.

#### `logger.mute()`

#### `logger.unmute()`

Disable or restore all logging output.

#### `const logs = parseLogs(rawLogs)`

Parse a newline-delimited JSON log string into an array of records. Empty lines are ignored; invalid JSON throws.

```js
const { parseLogs } = require('hyperlogger')

const logs = parseLogs(rawLogs)
```

#### `LEVELS`

Exported severity numbers: `TRACE: 1`, `DEBUG: 5`, `INFO: 9`, `WARN: 13`, `ERROR: 17`.

## License

Apache-2.0
