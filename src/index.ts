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
function extractTextFromLayout(
  documentText: string,
  textAnchor:
    | protos.google.cloud.documentai.v1.Document.ITextAnchor
    | null
    | undefined,
): string {
  if (!textAnchor || !textAnchor.textSegments) {
    return ''
  }

  let out = ''
  for (const segment of textAnchor.textSegments) {
    const start = Number(segment.startIndex ?? 0)
    const end = Number(segment.endIndex ?? 0)
    out += documentText.slice(start, end)
  }
  return out
}

function processTokens(
  document: ProcessDocumentResponse,
  page: protos.google.cloud.documentai.v1.Document.IPage,
): [
  {
    word: string
    x0: number
    originalYTop: number
    originalYBottom: number
    wordWidth: number
  }[],
  number,
  number,
  number,
] {
  if (!page) {
    return [[], 0, 0, 0]
  }

  // 1) Initialize
  let left = Infinity
  let right = -Infinity
  let rowHeight = page.dimension?.height || Infinity
  const words: {
    word: string
    x0: number
    originalYTop: number
    originalYBottom: number
    // y0: number
    wordWidth: number
  }[] = []
  for (const token of page.lines ?? []) {
    const layout = token.layout
    if (!layout) {
      continue
    }

    const tokenText = extractTextFromLayout(document.text!, layout.textAnchor)
    if (!tokenText) {
      continue
    }

    // 4) Extract bounding box
    const boundingPoly = layout.boundingPoly
    if (!boundingPoly?.normalizedVertices || !page.dimension) {
      // Could also handle non-normalized boundingPoly here
      continue
    }

    const { width: pageWidth = 0, height: pageHeight = 0 } = page.dimension

    // We'll assume the typical: top-left = 0, bottom-right = 2
    const x0 = boundingPoly.normalizedVertices[0].x! * pageWidth!
    const y0 = boundingPoly.normalizedVertices[0].y! * pageHeight!
    const x1 = boundingPoly.normalizedVertices[2].x! * pageWidth!
    const y1 = boundingPoly.normalizedVertices[2].y! * pageHeight!

    // const errorProneY = (y0 + y1) / 2

    const wordWidth = x1 - x0
    const wordHeight = y1 - y0

    if (rowHeight > wordHeight) {
      rowHeight = wordHeight
    }

    // we use the bottom of the token as the row
    // const oy = Math.round(Math.max(errorProneY))

    // Track left and right extremes
    if (x0 < left) {
      left = x0
    }
    if (x1 > right) {
      right = x1
    }

    words.push({
      word: tokenText,
      x0,
      originalYTop: y0,
      originalYBottom: y1,
      // y0: oy,
      wordWidth,
    })
  }
  // 5) Return the data for further layout processing
  return [words, left, right, rowHeight]
}

type Line = {
  words: {
    word: string
    x0: number
    originalYTop: number
    originalYBottom: number
    wordWidth: number
  }[]
}

function makeLinesWithIntersection(
  words: {
    word: string
    x0: number
    originalYTop: number
    originalYBottom: number
    wordWidth: number
  }[],
): {
  words: {
    word: string
    x0: number
    originalYTop: number
    originalYBottom: number
    wordWidth: number
  }[]
  top: number
  bottom: number
}[] {
  /**
   * We'll define each "line" as an object with:
   *   {
   *     words: Word[],      // the words that belong to this line
   *     top: number,        // min of all originalYTop values in the line
   *     bottom: number,     // max of all originalYBottom values in the line
   *   }
   * Then we decide if a new word belongs to an existing line by checking
   * vertical overlap with that line's [top, bottom] interval.
   */

  const lines: {
    words: {
      word: string
      x0: number
      originalYTop: number
      originalYBottom: number
      wordWidth: number
    }[]
    top: number
    bottom: number
  }[] = []

  // Sort words by their "originalYTop" so we process top-to-bottom
  // (You could also sort by center or bottom—just be consistent.)
  words.sort((a, b) => a.originalYTop - b.originalYTop)

  for (const w of words) {
    // Try to find an existing line whose vertical interval intersects
    // with the word's vertical range [originalYTop, originalYBottom].
    let foundLine: number | null = null
    let overlapPercentage = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Calculate the overlap between the word and the line
      const overlapTop = Math.max(line.top, w.originalYTop)
      const overlapBottom = Math.min(line.bottom, w.originalYBottom)
      const overlap = overlapBottom - overlapTop

      const wordHeight = w.originalYBottom - w.originalYTop
      if (wordHeight <= 0) continue // Prevent division by zero or negative heights

      overlapPercentage = Math.max(
        0,
        Math.min(100, Math.round((overlap / wordHeight) * 100)),
      )

      // Check if overlap is greater than or equal to 70%
      if (overlapPercentage >= 65) {
        foundLine = i
        break
      }
    }

    if (foundLine !== null) {
      // Update existing line
      lines[foundLine].words.push(w)
      // Extend the line's bounding box if needed
      if (w.originalYTop < lines[foundLine].top) {
        lines[foundLine].top = w.originalYTop
      }
      if (w.originalYBottom > lines[foundLine].bottom) {
        lines[foundLine].bottom = w.originalYBottom
      }
    } else {
      // Create a new line
      lines.push({
        words: [w],
        top: w.originalYTop,
        bottom: w.originalYBottom,
      })
    }
  }

  // Sort lines by their top coordinate (so top lines come first)
  lines.sort((a, b) => a.top - b.top)

  // Within each line, sort words by x0 so that they appear left-to-right
  for (const line of lines) {
    line.words.sort((a, b) => a.x0 - b.x0)
    console.log(line.words)
  }

  return lines
}

/**
 * Compute a global "slot" size and also store min/median/max word widths per line.
 *
 * @param lines the lines you have from makeLinesWithIntersection
 * @param left the minimal x0 on the page
 * @param right the maximal x1 on the page
 * @returns [globalSlot, lineSlots] where lineSlots[lineIndex] = [min, median, max]
 */
function computeSlots(
  lines: Line[],
  left: number,
  right: number,
): [number, Array<[number, number, number]>] {
  // A first guess for the slot is the total used_width
  const usedWidth = right - left
  let globalSlot = usedWidth
  console.log(`usedWidth: ${usedWidth}`)
  console.log(`left: ${left} right: ${right}`)
  // We'll store min/median/max for each line
  const lineSlots: Array<[number, number, number]> = []

  // For each line, gather widths and compute min, median, max
  lines.forEach((line, i) => {
    if (line.words.length < 1) {
      // if no words, just skip
      lineSlots[i] = [1, 1, 1]
      return
    }
    // gather all word widths
    const widths = line.words.map((w) => w.wordWidth).sort((a, b) => a - b)
    const minW = widths[0]
    const maxW = widths[widths.length - 1]
    console.log(`minW: ${minW} maxW: ${maxW}`)
    // find median
    const mid = Math.floor(widths.length / 2)
    let median = widths[mid]
    if (widths.length % 2 === 0 && mid > 0) {
      // average of middle two if even number
      median = (widths[mid - 1] + widths[mid]) / 2
    }

    // store results
    lineSlots[i] = [minW, median, maxW]

    // check if line is "significant"
    const lineSum = widths.reduce((acc, w) => acc + w, 0)
    const lineWidthRatio = lineSum / usedWidth
    if (lineWidthRatio >= 0.3 && median < globalSlot) {
      // if line is significant, update global slot
      globalSlot = median
    }
  })

  return [globalSlot, lineSlots]
}

/**
 * Rebuild text lines with spacing, using a slot approach.
 *
 * @param lines lines from makeLinesWithIntersection
 * @param left smallest x0 on the page
 * @param globalSlot the "average" or "median" word width
 * @param lineSlots array of [min, median, max] for each line
 * @returns array of strings, one for each line, with spacing
 */
function renderLinesWithSlots(
  lines: { words: Word[]; top: number; bottom: number }[],
  left: number,
  globalSlot: number,
  lineSlots: Array<[number, number, number]>,
  rowHeight: number,
): string[] {
  // rowHeight is from your page or average line height measurement
  const outputLines: string[] = []

  // We also need to keep track of the last line's bottom
  let lastLineBottom = -Infinity

  lines.forEach((line, lineIndex) => {
    // Check vertical gap
    if (lastLineBottom !== -Infinity) {
      const verticalGap = line.top - lastLineBottom
      // If this line's top is more than 1.5 × rowHeight below the last line,
      // let's add a blank line:
      if (verticalGap > 1.5 * rowHeight) {
        outputLines.push('') // blank line
      }
    }

    // Now do the standard spacing logic for each line
    // (the same code you have in renderLinesWithSlots, just integrated here)
    let text = ''
    const words = line.words.sort((a, b) => a.x0 - b.x0)

    // We can use the globalSlot or a line-specific slot
    const slot = globalSlot
    let lastPrintedSlotIndex = 0

    for (const w of words) {
      const offset = w.x0 - left
      const slotIndex = Math.floor(offset / slot)
      let spaceCount = slotIndex - lastPrintedSlotIndex
      if (spaceCount < 1) spaceCount = 1

      text += ' '.repeat(spaceCount)
      text += w.word.replace(/\n/g, ' ')

      const wordSlotSpan = Math.ceil(w.wordWidth / slot)
      lastPrintedSlotIndex = slotIndex + wordSlotSpan
    }

    // Push final line text
    outputLines.push(text.trimEnd())

    // Update lastLineBottom to this line’s bottom
    lastLineBottom = line.bottom
  })

  return outputLines
}

function processJSON(document: ProcessDocumentResponse) {
  if (!document || !document.pages || document.pages.length === 0) {
    return 'No pages found in the document.'
  }

  return document.pages
    .map((page) => {
      // 1) Gather words + minX + maxX
      const [words, left, right, rowHeight] = processTokens(document, page)

      // 2) Group words into lines
      const lines = makeLinesWithIntersection(words)

      // 3) Compute a global slot from all lines
      const [globalSlot, lineSlots] = computeSlots(lines, left, right)

      // 4) Rebuild each line's text using spacing
      const spacedLines = renderLinesWithSlots(
        lines,
        left,
        globalSlot,
        lineSlots,
        rowHeight, // from processTokens
      )

      // Finally, join them with newlines
      return spacedLines.join('\n')
    })
    .join('\n---\n')
}

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
