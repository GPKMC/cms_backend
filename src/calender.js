// calendar.js
import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const Calender = express.Router();

Calender.get("/", async (req, res) => {
  try {
    const response = await axios.get("https://calendarific.com/api/v2/holidays", {
      params: {
        api_key: process.env.CALENDARIFIC_KEY,
        country: process.env.COUNTRY || "NP",
        year: process.env.YEAR || new Date().getFullYear(),
      },
    });

    const holidays = response.data.response.holidays;

    // Only send relevant info
    const formattedHolidays = holidays.map((h) => ({
      name: h.name,
      description: h.description,
      date: h.date.iso,
      type: h.type,
    }));

    res.json({ holidays: formattedHolidays });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Failed to fetch calendar" });
  }
});

export default Calender;
