import path from 'node:path'
import fs from 'node:fs/promises'
import { protos } from '@google-cloud/documentai'

const documentAIJSONPath = path.join(__dirname, '../document-ai-json')
type ProcessDocumentResponse = protos.google.cloud.documentai.v1.IDocument

async function listJSONs(baseDir: string) {
  const files = await fs.readdir(baseDir)
  return files
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.join(baseDir, file))
}

async function parseJSON(filePath: string) {
  const file = await fs.readFile(filePath, 'utf8')
  const json = JSON.parse(file)
  return json as ProcessDocumentResponse
}

/**
 * Extract text for a token from Document AI's "textAnchor" offsets.
 */
function extractTextFromLayout(
  documentText: string,
  textAnchor:
    | protos.google.cloud.documentai.v1.Document.ITextAnchor
    | null
    | undefined,
): string {
  if (!textAnchor || !textAnchor.textSegments) return ''

  let out = ''
  for (const segment of textAnchor.textSegments) {
    const start = Number(segment.startIndex ?? 0)
    const end = Number(segment.endIndex ?? 0)
    out += documentText.slice(start, end)
  }
  return out
}

// ----------------------------------------------------
// Data structures
// ----------------------------------------------------
type Word = {
  word: string
  x0: number
  originalYTop: number
  originalYBottom: number
  wordWidth: number
}

type Line = {
  words: Word[]
  top: number
  bottom: number
}

// ----------------------------------------------------
// Step 1: Process tokens => gather all words
// ----------------------------------------------------
function processTokens(
  document: ProcessDocumentResponse,
  page: protos.google.cloud.documentai.v1.Document.IPage,
): [Word[], number, number, number] {
  if (!page) {
    return [[], 0, 0, 0]
  }

  let left = Infinity
  let right = -Infinity
  let rowHeight = page.dimension?.height || Infinity
  const words: Word[] = []

  for (const line of page.lines ?? []) {
    const layout = line.layout
    if (!layout) continue

    const tokenText = extractTextFromLayout(document.text!, layout.textAnchor)
    if (!tokenText) continue

    const boundingPoly = layout.boundingPoly
    if (!boundingPoly?.normalizedVertices || !page.dimension) continue

    const { width: pageWidth = 0, height: pageHeight = 0 } = page.dimension

    // Typically top-left = 0, bottom-right = 2
    const x0 = boundingPoly.normalizedVertices[0].x! * pageWidth
    const y0 = boundingPoly.normalizedVertices[0].y! * pageHeight
    const x1 = boundingPoly.normalizedVertices[2].x! * pageWidth
    const y1 = boundingPoly.normalizedVertices[2].y! * pageHeight

    const wWidth = x1 - x0
    const wHeight = y1 - y0

    // Track minimal rowHeight among words
    if (wHeight > 0 && wHeight < rowHeight) {
      rowHeight = wHeight
    }

    // Update left and right extremes
    if (x0 < left) left = x0
    if (x1 > right) right = x1

    words.push({
      word: tokenText,
      x0,
      originalYTop: y0,
      originalYBottom: y1,
      wordWidth: wWidth,
    })
  }

  return [words, left, right, rowHeight]
}

// ----------------------------------------------------
// Step 2: Build lines by vertical overlap
// ----------------------------------------------------
function makeLinesWithIntersection(words: Word[]): Line[] {
  const lines: Line[] = []

  // Sort by top
  words.sort((a, b) => a.originalYTop - b.originalYTop)

  for (const w of words) {
    let foundLine: number | null = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const overlapTop = Math.max(line.top, w.originalYTop)
      const overlapBottom = Math.min(line.bottom, w.originalYBottom)
      const overlap = overlapBottom - overlapTop
      const wordHeight = w.originalYBottom - w.originalYTop
      if (wordHeight <= 0) continue

      const overlapPct = (overlap / wordHeight) * 100
      if (overlapPct >= 65) {
        foundLine = i
        break
      }
    }

    if (foundLine !== null) {
      // Merge into existing line
      const line = lines[foundLine]
      line.words.push(w)
      // Update bounding box
      if (w.originalYTop < line.top) line.top = w.originalYTop
      if (w.originalYBottom > line.bottom) line.bottom = w.originalYBottom
    } else {
      lines.push({
        words: [w],
        top: w.originalYTop,
        bottom: w.originalYBottom,
      })
    }
  }

  // Final sorting
  lines.sort((a, b) => a.top - b.top)
  for (const ln of lines) {
    ln.words.sort((a, b) => a.x0 - b.x0)
  }

  return lines
}

// ----------------------------------------------------
// Word-to-Word approach (non-tabular fallback)
// ----------------------------------------------------
function renderLinesWordToWord(lines: Line[], rowHeight: number): string[] {
  const output: string[] = []
  let lastLineBottom = -Infinity

  // A simplistic "globalSlot" from the median wordWidth
  const allWidths: number[] = []
  for (const ln of lines) {
    for (const w of ln.words) {
      allWidths.push(w.wordWidth)
    }
  }
  allWidths.sort((a, b) => a - b)

  let globalSlot = 10
  if (allWidths.length > 0) {
    const mid = Math.floor(allWidths.length / 2)
    globalSlot = allWidths[mid] || 10
  }

  // Tweak globalSlot if you want to reduce spacing more aggressively
  // globalSlot *= 0.5 // e.g., cut spacing in half

  for (const line of lines) {
    // 1) Insert a blank line if there's a big vertical gap (e.g., > 1.5× rowHeight)
    if (lastLineBottom !== -Infinity) {
      const verticalGap = line.top - lastLineBottom
      if (verticalGap > 1.5 * rowHeight) {
        output.push('') // blank line
      }
    }

    // 2) Construct line's text
    let lineText = ''
    let lastXEnd = line.words.length > 0 ? line.words[0].x0 : 0

    for (const w of line.words) {
      const gap = w.x0 - lastXEnd
      let spaceCount = Math.round(gap / globalSlot)
      if (spaceCount < 1) spaceCount = 1
      if (spaceCount > 25) spaceCount = 25 // clamp

      lineText += ' '.repeat(spaceCount)
      lineText += w.word.replace(/\n/g, ' ')

      lastXEnd = w.x0 + w.wordWidth
    }

    output.push(lineText.trimEnd())
    lastLineBottom = line.bottom
  }

  return output
}

// ----------------------------------------------------
// MAIN "processJSON" to combine everything
// ----------------------------------------------------
function processJSON(document: ProcessDocumentResponse) {
  if (!document || !document.pages || document.pages.length === 0) {
    return 'No pages found in the document.'
  }

  return document.pages
    .map((page) => {
      const [words, left, right, rowHeight] = processTokens(document, page)
      if (!words.length) return ''

      // Group words into lines
      const lines = makeLinesWithIntersection(words)

      // Always do the word-to-word approach with vertical gap detection
      const spacedLines = renderLinesWordToWord(lines, rowHeight)
      return spacedLines.join('\n')
    })
    .join('\n---\n')
}

// ----------------------------------------------------
// Final main()
// ----------------------------------------------------
async function main() {
  const files = await listJSONs(documentAIJSONPath)
  for await (const file of files) {
    const parsedJSON = await parseJSON(file)
    const text = processJSON(parsedJSON)
    await fs.writeFile(
      path.resolve(
        __dirname,
        '../document-ai-text',
        path.basename(file).replace(/\.json$/, '.txt'),
      ),
      text,
    )
  }
}

main()
