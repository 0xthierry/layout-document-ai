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

  // TODO: handle N pages
  const page = document.pages[0];
  const { width, height, unit } = page.dimension || { width: 0, height: 0 };

  console.log(`width: ${width}, height: ${height} ${unit}\n`);


  // the blocks / paragraphs / lines are not ordered, and we could order it using the bounding box position
  const sortedBlocks = page.blocks?.slice().sort((a, b) => {
    const aY = a.layout?.boundingPoly?.normalizedVertices?.[0]?.y || 0;
    const bY = b.layout?.boundingPoly?.normalizedVertices?.[0]?.y || 0;
    const aX = a.layout?.boundingPoly?.normalizedVertices?.[0]?.x || 0;
    const bX = b.layout?.boundingPoly?.normalizedVertices?.[0]?.x || 0;

    if (Math.abs(aY - bY) < 0.01) {
      return aX - bX;
    }
    return aY - bY;
  });

  let text = "";

  return text;
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
