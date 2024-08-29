import path from 'node:path'
import fs from 'node:fs/promises'
import { protos } from '@google-cloud/documentai'

const documentAIJSONPath = path.join(__dirname, '../document-ai-json')
type ProcessDocumentResponse = protos.google.cloud.documentai.v1.IDocument

const calculateAverageY = (
  value: protos.google.cloud.documentai.v1.Document.Page.IToken,
): number => {
  const topLeftY = value.layout?.boundingPoly?.normalizedVertices?.[0].y ?? 0
  const bottomLeftY = value.layout?.boundingPoly?.normalizedVertices?.[3].y ?? 0
  return (topLeftY + bottomLeftY) / 2
}

const calculateAverageX = (
  value: protos.google.cloud.documentai.v1.Document.Page.IToken,
): number => {
  const topLeftX = value.layout?.boundingPoly?.normalizedVertices?.[0].x ?? 0
  const bottomLeftX = value.layout?.boundingPoly?.normalizedVertices?.[3].x ?? 0
  return (topLeftX + bottomLeftX) / 2
}

const calculateLineDistances = (
  lines: protos.google.cloud.documentai.v1.Document.Page.IToken[][],
): number[] => {
  const distances: number[] = []
  for (let i = 0; i < lines.length - 1; i++) {
    const avgCurrentLineY =
      lines[i].reduce((acc, value) => acc + calculateAverageY(value), 0) /
      lines[i].length
    const avgNextLineY =
      lines[i + 1].reduce((acc, value) => acc + calculateAverageY(value), 0) /
      lines[i + 1].length
    distances.push(Math.abs(avgNextLineY - avgCurrentLineY))
  }
  return distances
}

const determineDynamicThreshold = (distances: number[]): number => {
  const meanDistance = distances.reduce((a, b) => a + b, 0) / distances.length
  const stdDistance = Math.sqrt(
    distances.reduce((a, b) => a + Math.pow(b - meanDistance, 2), 0) /
      distances.length,
  )
  console.log(`mean: ${meanDistance}, std: ${stdDistance}`)
  return meanDistance
}

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

function processPage(
  document: ProcessDocumentResponse,
  page: protos.google.cloud.documentai.v1.Document.IPage,
): string {
  if (!page) {
    return 'No pages found in the document.'
  }

  const { width, height, unit } = page.dimension || { width: 0, height: 0 }

  console.log(`width: ${width}, height: ${height} ${unit}\n`)

  // Sort blocks by bounding box positions
  const sortedBlocks = page.tokens?.slice().sort((a, b) => {
    const aY = calculateAverageY(a)
    const bY = calculateAverageY(b)
    const aX = calculateAverageX(a)
    const bX = calculateAverageX(b)

    if (Math.abs(aY - bY) < 0.01) {
      return aX - bX
    }
    return aY - bY
  }) as protos.google.cloud.documentai.v1.Document.Page.IToken[]

  let text = ''

  function concatenateText(
    layout: protos.google.cloud.documentai.v1.Document.Page.ILayout,
  ) {
    return layout.textAnchor?.textSegments
      ?.map((segment) =>
        document?.text
          ?.substring(
            (segment?.startIndex as number) ?? 0,
            (segment?.endIndex as number) ?? 0,
          )
          .trim(),
      )
      .join('')
  }

  const lines: protos.google.cloud.documentai.v1.Document.Page.IToken[][] = []
  let currentLine: protos.google.cloud.documentai.v1.Document.Page.IToken[] = []
  let previousY: number | null = null

  sortedBlocks.forEach((block) => {
    const currentY = calculateAverageY(block)

    if (previousY === null || Math.abs(currentY - previousY) < 0.01) {
      currentLine.push(block)
    } else {
      lines.push(currentLine)
      currentLine = [block]
    }

    previousY = currentY
  })

  if (currentLine.length > 0) {
    lines.push(currentLine)
  }

  const lineDistances = calculateLineDistances(lines)
  const threshold = determineDynamicThreshold(lineDistances)

  const finalLines: protos.google.cloud.documentai.v1.Document.Page.IToken[][] =
    []

  lines.forEach((line, index) => {
    finalLines.push(line)
    if (index < lines.length - 1) {
      const distanceToNextLine = lineDistances[index]
      if (distanceToNextLine > threshold) {
        finalLines.push([]) // Add empty line to represent a significant gap
      }
    }
  })

  finalLines.forEach((line) => {
    let lineText = ''
    line.forEach((block) => {
      if (block.layout) {
        const textSegment = concatenateText(block.layout) ?? ''
        if (lineText.length > 0 && !isPunctuation(textSegment)) {
          lineText += ' '
        }
        lineText += textSegment
      }
    })
    text += lineText.trim() + '\n'
  })

  return text.trim()
}

function processJSON(document: ProcessDocumentResponse) {
  if (!document || !document.pages || document.pages.length === 0) {
    return 'No pages found in the document.'
  }

  return document.pages
    .map((page) => processPage(document, page))
    .join('\n---\n')
}

function isPunctuation(text: string): boolean {
  const punctuationMarks = ['.', ',', '!', '?', ';', ':']
  return punctuationMarks.includes(text)
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
