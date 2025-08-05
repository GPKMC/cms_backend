import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import textract from "textract";
import Tesseract from "tesseract.js";
import fs from "fs-extra";
import path from "path";
import { execSync } from "child_process";
import spliddit from "spliddit"; // NEW: Robust word segmenter

// ---- TEXT NORMALIZATION ----
function cleanText(text) {
  if (!text) return "";
  let out = text
    .replace(/[\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^\x00-\x7F]+/g, "")
    .trim()
    .toLowerCase();

  // If too few spaces (less than 2%), try to segment only if *really* merged
  const spaceRatio = (out.split(" ").length - 1) / out.length;
  if (spaceRatio < 0.02 && out.length > 15) {
    // Only use letters
    let trySegment = out.replace(/[^a-z]/g, "");
    // Only segment if there are no spaces at all (joined text)
    if (!out.includes(" ")) {
      const segmented = spliddit(trySegment).join(" ");
      // Only update if segmentation increased the space count
      if (segmented.split(" ").length > 2) out = segmented;
    }
  }
  return out;
}

function logSample(label, text) {
  console.log(label, text?.slice(0, 400), "\n--- END SAMPLE ---");
}

// --- Extractors ---

// OCR for images
async function ocrImage(imagePath) {
  try {
    const { data: { text } } = await Tesseract.recognize(imagePath, "eng");
    logSample("OCR raw text:", text);
    return cleanText(text);
  } catch (e) {
    console.error("OCR failed for image:", imagePath, e);
    return "";
  }
}

// DOCX/DOC extraction (try mammoth, fallback to textract)
async function extractDocx(filePath) {
  try {
    const { value } = await mammoth.extractRawText({ path: filePath });
    logSample("Mammoth DOCX text:", value);
    if (value && value.trim().length > 20 && (value.match(/\s/g) || []).length < value.length / 40) {
      // If almost no spaces, fallback to textract (might be scanned docx)
      console.warn("DOCX appears to have no spaces, trying textract...");
      return await new Promise((resolve) => {
        textract.fromFileWithPath(filePath, { preserveLineBreaks: true }, (err, text) => {
          if (err) {
            console.error("Textract failed for DOCX:", filePath, err);
            resolve(cleanText(value));
          } else {
            logSample("Textract DOCX text:", text);
            resolve(cleanText(text || ""));
          }
        });
      });
    }
    return cleanText(value || "");
  } catch (e) {
    console.error("Failed to extract DOCX with mammoth:", filePath, e);
    // fallback to textract
    return await new Promise((resolve) => {
      textract.fromFileWithPath(filePath, { preserveLineBreaks: true }, (err, text) => {
        if (err) {
          console.error("Textract failed for DOCX:", filePath, err);
          resolve("");
        } else {
          logSample("Textract DOCX text:", text);
          resolve(cleanText(text || ""));
        }
      });
    });
  }
}

// Plain .txt
async function extractTxt(filePath) {
  try {
    const txt = await fs.readFile(filePath, "utf8");
    logSample("TXT extracted:", txt);
    return cleanText(txt || "");
  } catch (e) {
    console.error("Failed to extract TXT:", filePath, e);
    return "";
  }
}

// Rich Text .rtf
async function extractRtf(filePath) {
  try {
    const { parseRtf } = await import('text-rtf');
    const text = parseRtf(await fs.readFile(filePath, "utf8"));
    logSample("RTF extracted:", text);
    return cleanText(text || "");
  } catch (e) {
    console.error("Failed to extract RTF:", filePath, e);
    return "";
  }
}

// PDF pages to images
async function convertPdfToPng(pdfPath, outputDir) {
  await fs.ensureDir(outputDir);
  const outputPrefix = path.join(outputDir, "page");
  try {
    execSync(`pdftoppm -png "${pdfPath}" "${outputPrefix}"`, { stdio: "ignore" });
  } catch (e) {
    console.error("Error running pdftoppm:", e.message);
    throw e;
  }
  const files = await fs.readdir(outputDir);
  return files.filter(f => f.endsWith(".png")).map(f => path.join(outputDir, f));
}

// PDF extractor with OCR fallback
async function extractPdf(filePath) {
  try {
    if (!await fs.pathExists(filePath)) {
      console.error("File does not exist:", filePath);
      return "";
    }
    const buffer = await fs.readFile(filePath);
    const data = await pdfParse(buffer);
    logSample("PDF text from pdf-parse:", data.text);
    // If text has spaces, use it. If not, fallback to OCR.
    if (data.text && data.text.trim().length > 30 && /\s/.test(data.text)) {
      return cleanText(data.text);
    }
    console.log("No meaningful/space-separated text from pdf-parse, falling back to OCR...");
    // OCR fallback
    const tempDir = path.join(path.dirname(filePath), "temp_ocr_" + Date.now());
    const images = await convertPdfToPng(filePath, tempDir);
    let fullText = "";
    for (const imgPath of images) {
      console.log("Running OCR on image:", imgPath);
      const text = await ocrImage(imgPath); // ocrImage already calls cleanText
      fullText += text + " ";
    }
    await fs.remove(tempDir);
    logSample("PDF text from OCR:", fullText);
    return cleanText(fullText);
  } catch (err) {
    console.error("Failed to extract PDF:", filePath, err);
    return "";
  }
}

// Unified entry point
export async function extractTextFromFile(filePath, mimetype = "") {
  if (!filePath) return "";
  const ext = path.extname(filePath).toLowerCase();
  let text = "";
  if (mimetype === "application/pdf" || ext === ".pdf") text = await extractPdf(filePath);
  else if (
    mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimetype === "application/msword" ||
    ext === ".docx" ||
    ext === ".doc"
  ) text = await extractDocx(filePath);
  else if (mimetype.startsWith("image/") || [".jpg", ".jpeg", ".png", ".webp"].includes(ext)) text = await ocrImage(filePath);
  else if (mimetype === "text/plain" || ext === ".txt") text = await extractTxt(filePath);
  else if (mimetype === "application/rtf" || ext === ".rtf") text = await extractRtf(filePath);

  // Add logging here
  console.log(`[ExtractTextFromFile] (${filePath}) extracted:`, (text || '').slice(0, 400));
  return text || "";
}
