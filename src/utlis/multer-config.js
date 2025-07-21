import multer from "multer";
import path from "path";
import fs from "fs";

// Helper: ensure directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let subdir = "others";
    if (file.mimetype.startsWith("image/")) {
      subdir = "images";
    } else if (
      file.mimetype === "application/pdf" ||
      file.mimetype.includes("word") ||
      file.mimetype.includes("presentation") ||
      file.mimetype.includes("spreadsheet") ||
      file.mimetype === "text/plain"
    ) {
      subdir = "documents";
    }
    const dest = path.join(process.cwd(), "uploads", "announcements", subdir);
    ensureDir(dest);
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname.replace(/\s+/g, "_"));
  }
});

const upload = multer({ storage });
export default upload;
