// models/Admin.js
import mongoose from "mongoose";

const adminSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },

  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    validate: {
      validator: function (email) {
        return email.endsWith("@gpkmc.edu.np");
      },
      message: "Admin email must end with @gpkmc.edu.np",
    },
  },

  password: { type: String, required: true },

  phone: { type: String, trim: true },
}, { timestamps: true });

const Admin = mongoose.model("Admin", adminSchema);
export default Admin;
