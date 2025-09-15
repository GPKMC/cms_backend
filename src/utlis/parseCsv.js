// src/utils/parseCSV.js
import fs from "fs";
import csv from "csv-parser";

export const parseCSV = (filePath) =>
  new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(
        csv({
          // strip BOM, trim, and lowercase headers so "Username" works too
          mapHeaders: ({ header }) =>
            header ? header.toString().replace(/^\uFEFF/, "").trim().toLowerCase() : header,
          // trim values
          mapValues: ({ value }) =>
            typeof value === "string" ? value.trim() : value,
        })
      )
      .on("data", (row) => {
        // ignore fully empty lines
        if (Object.values(row).every((v) => (v ?? "").toString().trim() === "")) return;
        rows.push(row);
      })
      .on("end", () => resolve(rows))
      .on("error", (err) => reject(err));
  });
