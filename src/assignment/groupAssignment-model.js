import mongoose from "mongoose";
const { Schema } = mongoose;

// ——— Per-group discussion schema ———
const groupDiscussionSchema = new Schema({
  user:      { type: Schema.Types.ObjectId, ref: "User", required: true },
  message:   { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

// ——— Per-member participation/logsheet ———
const participationSchema = new Schema({
  user:              { type: Schema.Types.ObjectId, ref: "User", required: true },
  contribution:      String,
  files:             [String],
  messageCount:      { type: Number, default: 0 },
  discussionMinutes: { type: Number, default: 0 }
}, { _id: false });

// ——— Per-group schema ———
const groupSchema = new Schema({
  task:    { type: String, required: true },
  name:    String, // optional name, auto-filled below if missing

  // Optional per-group overrides (title, content, attachments)
  title:       String,
  content:     String,
  media:       [{ url: String, originalname: String }],
  documents:   [{ url: String, originalname: String }],
  youtubeLinks:[String],
  links:       [String],

  members: {
    type: [{ type: Schema.Types.ObjectId, ref: "User" }],
    validate: v => Array.isArray(v) && v.length > 0
  },

  topic: { type: Schema.Types.ObjectId, ref: "Topic" },

  discussion:   [groupDiscussionSchema],
  participation:[participationSchema],

  marks:    Number,
  feedback: String
});

// ——— Top-level group assignment schema ———
const groupAssignmentSchema = new Schema({
  title:         { type: String, required: true },
  content:       { type: String },
  postedBy:      { type: Schema.Types.ObjectId, ref: "User", required: true },
  courseInstance:{ type: Schema.Types.ObjectId, ref: "CourseInstance" },
  topic:         { type: Schema.Types.ObjectId, ref: "Topic" },

  media:       [{ url:String, originalname:String }],
  documents:   [{ url:String, originalname:String }],
  youtubeLinks:[String],
  links:       [String],

  groups:      [groupSchema],

  dueDate:     Date,
  points:      { type: Number, default: 0 },

  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now }
});

// Auto-assign default group names ("Team A", "Team B", etc.) if missing
groupAssignmentSchema.pre("save", function(next) {
  this.updatedAt = Date.now();

  if (Array.isArray(this.groups)) {
    this.groups = this.groups.map((grp, idx) => {
      if (grp.name && grp.name.trim()) return grp;
      const letter = String.fromCharCode(65 + idx);
      return {
        ...grp.toObject?.(),
        name: `Team ${letter}`
      };
    });
  }

  next();
});

export default mongoose.models.GroupAssignment ||
  mongoose.model("GroupAssignment", groupAssignmentSchema);
