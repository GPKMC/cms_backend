import mongoose from "mongoose";
const { Schema } = mongoose;

// ——— Per‑group submission schema ———
const groupSubmissionSchema = new Schema({
  submittedBy:   { type: Schema.Types.ObjectId, ref: "User", required: true },
  files:         [{
    url: String,
    originalname: String,
    filetype: String,
    extractedText: String,
  }],
  combinedText: { type: String, default: '' },
  embedding: [{ type: Number }],
  isFlagged: { type: Boolean, default: false },
  plagiarismPercentage: { type: Number, default: 0 }, // Overall max similarity %
  plagiarismMatches: [{
  type: { type: String, enum: ['submission', 'reference'], required: true },
  referenceId: { type: Schema.Types.ObjectId, ref: 'Reference' },
  studentId: { type: Schema.Types.ObjectId, ref: 'User' },
  similarity: { type: Number, required: true },       // similarity score (0 to 1)
  matchedText: { type: String, required: true },      // exact plagiarized text snippet
  lineNumber: { type: Number },                        // optional: line or sentence number in submission
  startCharIndex: { type: Number },                    // optional: start char index in combinedText
  endCharIndex: { type: Number }                       // optional: end char index in combinedText
}]
,
  message:       String,
  submittedAt:   { type: Date, default: Date.now },
  personalComments: [{
    user:      { type: Schema.Types.ObjectId, ref: "User", required: true },
    message:   String,
    createdAt: { type: Date, default: Date.now }
  }]
}, { _id: false });


// ——— Per‑group discussion schema ———
const groupDiscussionSchema = new Schema({
  user:      { type: Schema.Types.ObjectId, ref: "User", required: true },
  message:   { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

// ——— Per‑member participation/logsheet ———
const participationSchema = new Schema({
  user:              { type: Schema.Types.ObjectId, ref: "User", required: true },
  contribution:      String,
  files:             [String],
  messageCount:      { type: Number, default: 0 },
  discussionMinutes: { type: Number, default: 0 }
}, { _id: false });

// ——— Per‑group schema ———
const groupSchema = new Schema({
  // What this group must do (always present)
  
  task:    { type: String, required: true },

  // Optional human‑readable name for the group
  name:    String,    //  name of group`

  // Optional per‑group overrides—if absent, fall back to global:
  title :String,  //pergroup assignment title
  content:      String,
  media:       [{ url: String, originalname: String }],
  documents:   [{ url: String, originalname: String }],
  youtubeLinks:[String],
  links:       [String],

  // Who’s in this group
  members: {
    type: [{ type: Schema.Types.ObjectId, ref: "User" }],
    validate: v => Array.isArray(v) && v.length > 0
  },

  // Optional per‑group topic override
  topic: { type: Schema.Types.ObjectId, ref: "Topic" },

  // Records for this group
  submissions:  [groupSubmissionSchema],
  discussion:   [groupDiscussionSchema],
  participation:[participationSchema],

  // Grading fields
  marks:    Number,
  feedback: String
}, );

// ——— Top‑level group assignment schema ———
const groupAssignmentSchema = new Schema({
  // Global assignment fields
  title:         { type: String, required: true },
  content:       { type: String,  },
  postedBy:      { type: Schema.Types.ObjectId, ref: "User", required:true},
  courseInstance:{ type: Schema.Types.ObjectId, ref: "CourseInstance", },
  topic:         { type: Schema.Types.ObjectId, ref: "Topic" },

  // Global attachments & links
  media: [ { url:String, originalname:String } ],
  documents: [ { url:String, originalname:String } ],
  youtubeLinks: [String],
  links:        [String],

  // Array of groups (each has a required `task`, plus optional overrides)
  groups:        [groupSchema],

  // Global metadata
  dueDate:    Date,
  points:     { type: Number, default: 0 },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now }
});

// Auto‑assign default group names (“Team A”, “Team B”, …) when none provided
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
