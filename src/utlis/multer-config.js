// import multer from "multer";
// import path from "path";
// import fs from "fs";

// // Helper: ensure directory exists
// function ensureDir(dir) {
//   if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
// }

// // const storage = multer.diskStorage({
// //   destination: function (req, file, cb) {
// //     let subdir = "others";
// //     if (file.mimetype.startsWith("image/")) {
// //       subdir = "images";
// //     } else if (
// //       file.mimetype === "application/pdf" ||
// //       file.mimetype.includes("word") ||
// //       file.mimetype.includes("presentation") ||
// //       file.mimetype.includes("spreadsheet") ||
// //       file.mimetype === "text/plain"
// //     ) {
// //       subdir = "documents";
// //     }
// //     const dest = path.join(process.cwd(), "uploads", "announcements", subdir);
// //     ensureDir(dest);
// //     cb(null, dest);
// //   },
// //   filename: function (req, file, cb) {
// //     const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
// //     cb(null, uniqueSuffix + "-" + file.originalname.replace(/\s+/g, "_"));
// //   }
// // });


// // Get root folder based on endpoint
// function getRootFolder(req) {
//   // Customize if needed: you can set req.uploadType in your routers!
//   if (req.baseUrl.includes("materials")) return "course-materials";
//   if (req.baseUrl.includes("announcement")) return "announcements";
//   return "uploads"; // fallback
// }

// const storage = multer.diskStorage({
//   destination: function (req, file, cb) {
//     let subdir = "others";
//     if (file.mimetype.startsWith("image/")) {
//       subdir = "images";
//     } else if (
//       file.mimetype.includes("pdf") ||
//       file.mimetype.includes("word") ||
//       file.mimetype.includes("presentation") ||
//       file.mimetype.includes("spreadsheet") ||
//       file.mimetype.includes("csv") || // csv support
//       file.mimetype === "text/plain"
//     ) {
//       subdir = "documents";
//     }
//     // Dynamic root folder
//     const root = getRootFolder(req);
//     const dest = path.join(process.cwd(), "uploads", root, subdir);
//     ensureDir(dest);
//     cb(null, dest);
//   },
//   filename: function (req, file, cb) {
//     const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
//     cb(null, uniqueSuffix + "-" + file.originalname.replace(/\s+/g, "_"));
//   }
// });

// // Optional: restrict file types
// const allowedTypes = [
//   "application/pdf",
//   "application/msword",
//   "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
//   "application/vnd.ms-powerpoint",
//   "application/vnd.openxmlformats-officedocument.presentationml.presentation",
//   "application/vnd.ms-excel",
//   "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
//   "text/csv",
//   "image/png", "image/jpeg", "image/jpg",
//   "text/plain"
//   // Add more if needed
// ];

// function fileFilter(req, file, cb) {
//   // Allow all by default; add if you want restrictions
//   cb(null, true); // Accept everything (safe for classroom)
//   // To restrict:
//   // cb(null, allowedTypes.includes(file.mimetype));
// }

// const upload = multer({ storage, fileFilter });

// export default upload;
import multer from "multer";
import path from "path";
import fs from "fs";

// Helper: ensure directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Get root folder based on endpoint
function getRootFolder(req) {
  if (req.baseUrl.includes("materials")) return "course-materials";
  if (req.baseUrl.includes("announcement")) return "announcements";
  if (req.baseUrl.includes("assignment")) return "assignments";
  if (req.baseUrl.includes("question")) return "questions";
  return ""; // fallback
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let subdir = "others";
    if (file.mimetype.startsWith("image/")) {
      subdir = "images";
    } else if (
      file.mimetype.startsWith("video/") // <--- VIDEO support
    ) {
      subdir = "videos";
    } else if (
      file.mimetype.includes("pdf") ||
      file.mimetype.includes("word") ||
      file.mimetype.includes("presentation") ||
      file.mimetype.includes("spreadsheet") ||
      file.mimetype.includes("csv") ||
      file.mimetype === "text/plain"
    ) {
      subdir = "documents";
    }
    // Dynamic root folder
    const root = getRootFolder(req);
    const dest = path.join(process.cwd(), "uploads", root, subdir);
    ensureDir(dest);
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname.replace(/\s+/g, "_"));
  }
});

// Add common video MIME types here:
const allowedTypes = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "image/png", "image/jpeg", "image/jpg",
  "text/plain",
  // ---- Video types ----
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",    // .mov
  "video/x-msvideo",    // .avi
  "video/x-matroska",   // .mkv
];

function fileFilter(req, file, cb) {
  // Accept only allowed types
  cb(null, allowedTypes.includes(file.mimetype));
}

const upload = multer({ storage, fileFilter });

export default upload;
