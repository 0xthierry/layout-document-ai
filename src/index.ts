import path from 'node:path'
import fs from 'node:fs/promises'
import { protos } from '@google-cloud/documentai'

const documentAIJSONPath = path.join(__dirname, '../document-ai-json')
type ProcessDocumentResponse = protos.google.cloud.documentai.v1.IDocument

const calculateAverageY = (
  value: protos.google.cloud.documentai.v1.Document.Page.IBlock,
): number => {
  const topLeftY = value.layout?.boundingPoly?.normalizedVertices?.[0].y ?? 0
  const bottomLeftY = value.layout?.boundingPoly?.normalizedVertices?.[3].y ?? 0
  return (topLeftY + bottomLeftY) / 2
}

const calculateAverageX = (
  block: protos.google.cloud.documentai.v1.Document.Page.IBlock,
): number => {
  const topLeftX = block.layout?.boundingPoly?.normalizedVertices?.[0].x ?? 0
  const bottomLeftX = block.layout?.boundingPoly?.normalizedVertices?.[3].x ?? 0
  return (topLeftX + bottomLeftX) / 2
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

function processJSON(document: ProcessDocumentResponse): string {
  if (!document || !document.pages || document.pages.length === 0) {
    return 'No pages found in the document.'
  }

  const page = document.pages[0]
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
  }) as protos.google.cloud.documentai.v1.Document.Page.IBlock[]

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

  const lines: protos.google.cloud.documentai.v1.Document.Page.IBlock[][] = []
  let currentLine: protos.google.cloud.documentai.v1.Document.Page.IBlock[] = []
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

  lines.forEach((line) => {
    let lineText = ''
    line.forEach((block) => {
      if (block.layout) {
        lineText += concatenateText(block.layout) + ' '
      }
    })
    text += lineText.trim() + '\n'
  })

  return text.trim()
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
