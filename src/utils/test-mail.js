// src/routes/testMail.js
import express from "express";
import { getTransporter, getMailFrom, applyDebugRouting } from "../utils/mailer.js";

const testMail = express.Router();

testMail.get("/test-mail", async (req, res) => {
  try {
    const transporter = await getTransporter();
    const from = getMailFrom();
    const { to, bcc } = applyDebugRouting({ to: "your_email@example.com" });

    console.log("[TEST MAIL] Sending from:", from.email, "to:", to);

    await transporter.sendMail({
      from: `${from.name} <${from.email}>`,
      to,
      bcc,
      subject: "Render Test Email",
      text: "This is a test email from Render",
      html: "<h3>This is a test email from Render</h3>",
    });

    res.send("✅ Test email sent (check Mailjet dashboard)");
  } catch (err) {
    console.error("[TEST MAIL] Error:", err);
    res.status(500).send("❌ Failed to send email: " + err.message);
  }
});

export default testMail;
