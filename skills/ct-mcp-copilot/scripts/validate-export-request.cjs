const fs = require('fs')

function readInput() {
  const chunks = []
  const fd = 0
  try {
    const stat = fs.fstatSync(fd)
    if (stat.size === 0 && process.stdin.isTTY) {
      return null
    }
  } catch {}

  return fs.readFileSync(fd, 'utf8').trim() || null
}

function validate(payload) {
  const missingFields = []

  if (!payload.sessionId && !payload.query) missingFields.push('session')

  if (!payload.dateRange || !payload.dateRange.start || !payload.dateRange.end) {
    missingFields.push('dateRange')
  }

  if (!payload.format) {
    missingFields.push('format')
  }

  const media = payload.mediaOptions
  const completeMedia = media
    && typeof media.exportAvatars === 'boolean'
    && typeof media.exportImages === 'boolean'
    && typeof media.exportVideos === 'boolean'
    && typeof media.exportEmojis === 'boolean'
    && typeof media.exportVoices === 'boolean'

  if (!completeMedia) {
    missingFields.push('mediaOptions')
  }

  return {
    canExport: missingFields.length === 0,
    missingFields
  }
}

const raw = readInput()
if (!raw) {
  console.error('Provide a JSON payload via stdin.')
  process.exit(1)
}

let payload
try {
  payload = JSON.parse(raw)
} catch (error) {
  console.error(`Invalid JSON: ${error.message}`)
  process.exit(1)
}

process.stdout.write(`${JSON.stringify(validate(payload), null, 2)}\n`)
