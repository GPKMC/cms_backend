// Topic.js
import mongoose from "mongoose";
const { Schema } = mongoose;

const topicSchema = new Schema({
  title: { type: String, required: true },
  description: String,
  courseInstance: { type: Schema.Types.ObjectId, ref: "CourseInstance", required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true }, // Track who created it
}, { timestamps: true });

export default mongoose.model("Topic", topicSchema);
