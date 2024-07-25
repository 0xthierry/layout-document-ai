import path from "node:path";
import fs from "node:fs/promises";
import { protos } from "@google-cloud/documentai";

const documentAIJSONPath = path.join(__dirname, "../document-ai-json");
type ProcessDocumentResponse = protos.google.cloud.documentai.v1.IDocument;

async function listJSONs(baseDir: string) {
  const files = await fs.readdir(baseDir);
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(baseDir, file));
}

async function parseJSON(filePath: string) {
  const file = await fs.readFile(filePath, "utf8");
  const json = JSON.parse(file);
  return json as ProcessDocumentResponse;
}

function processJSON(document: ProcessDocumentResponse): string {
  if (!document || !document.pages || document.pages.length === 0) {
    return "No pages found in the document.";
  }

  const page = document.pages[0];
  const { width, height, unit } = page.dimension || { width: 0, height: 0 };

  console.log(`width: ${width}, height: ${height} ${unit}\n`);

  // Sort blocks by bounding box positions
  const sortedBlocks = page.tokens?.slice().sort((a, b) => {
    const aY = a.layout?.boundingPoly?.normalizedVertices?.[0]?.y || 0;
    const bY = b.layout?.boundingPoly?.normalizedVertices?.[0]?.y || 0;
    const aX = a.layout?.boundingPoly?.normalizedVertices?.[0]?.x || 0;
    const bX = b.layout?.boundingPoly?.normalizedVertices?.[0]?.x || 0;

    if (Math.abs(aY - bY) < 0.01) {
      return aX - bX;
    }
    return aY - bY;
  }) as protos.google.cloud.documentai.v1.Document.Page.IBlock[];

  let text = "";

  function concatenateText(layout) {
    return layout.textAnchor.textSegments.map(segment => document.text.substring(segment.startIndex, segment.endIndex).trim()).join('');
  }

  const lines = [];
  let currentLine: string[] = [];

  sortedBlocks.forEach((block, index) => {
    console.log(`Block: ${index}`)
    console.log(`Text: ${concatenateText(block.layout)}`)
    console.log(`Coords: y=${block.layout?.boundingPoly?.normalizedVertices?.[0].y},x=${block.layout?.boundingPoly?.normalizedVertices?.[0].x}`)
    console.log(`-----\n`)

    const blockY = block.layout?.boundingPoly?.normalizedVertices?.[0]?.y || 0;
    const nextBlockY = sortedBlocks[index + 1]?.layout?.boundingPoly?.normalizedVertices?.[0]?.y || blockY;

    currentLine.push(block);
    // TODO: calculate it dinamically
    if (Math.abs(blockY - nextBlockY) > 0.015) {
      lines.push(currentLine);
      currentLine = [];
    }
  });

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  // Concatenate text from grouped lines
  lines.forEach(line => {
    line.forEach(block => {
      if (block.layout) {
        text += concatenateText(block.layout) + " ";
      }
    });
    text = text.trim() + "\n";
  });

  return text.trim();
}

async function main() {
  const files = await listJSONs(documentAIJSONPath);
  for await (const file of files) {
    const parsedJSON = await parseJSON(file);
    const text = processJSON(parsedJSON);
    await fs.writeFile(
      path.resolve(
        __dirname,
        "../document-ai-text",
        path.basename(file).replace(/\.json$/, ".txt")
      ),
      text
    );
  }
}

main();
