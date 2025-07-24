import mongoose from "mongoose";
import express from "express";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import topicModel from "./topic-model.js";
import assignmentModel from "../assignment/assignmentModel.js";
import courseMaterialsModel from "./courseMaterials-model.js";
import questionModel from "../question/question-model.js";

const FeedRouter = express.Router();

FeedRouter.get(
  "/:courseInstanceId",
  authmiddleware,
  authorizedRole('teacher', 'student'),
  async (req, res) => {
    const { courseInstanceId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(courseInstanceId))
      return res.status(400).json({ error: "Invalid courseInstanceId" });

    try {
      const topics = await topicModel.find({ courseInstance: courseInstanceId }).lean();

      const [materials, assignments, questions] = await Promise.all([
        courseMaterialsModel.find({ courseInstance: courseInstanceId })
          .populate("postedBy", "username email")
          .populate("visibleTo", "username email")
          .lean(),
        assignmentModel.find({ courseInstance: courseInstanceId })
          .populate("postedBy", "username email")
          .populate("visibleTo", "username email")
          .lean(),
        questionModel.find({ courseInstance: courseInstanceId })
          .populate("postedBy", "username email")
          .populate("visibleTo", "username email")
          .lean(),
      ]);

      // Build topicMap with questions
      const topicMap = {};
      topics.forEach(topic => {
        topicMap[topic._id.toString()] = {
          topic,
          materials: [],
          assignments: [],
          questions: []
        };
      });

      const uncategorized = {
        topic: { _id: null, title: "No topic" },
        materials: [],
        assignments: [],
        questions: []
      };

      // Materials
      materials.forEach(mat => {
        if (mat.topic) {
          const t = topicMap[mat.topic?.toString()];
          if (t) t.materials.push(mat);
          else uncategorized.materials.push(mat);
        } else {
          uncategorized.materials.push(mat);
        }
      });
      // Assignments
      assignments.forEach(assign => {
        if (assign.topic) {
          const t = topicMap[assign.topic?.toString()];
          if (t) t.assignments.push(assign);
          else uncategorized.assignments.push(assign);
        } else {
          uncategorized.assignments.push(assign);
        }
      });
      // Questions
      questions.forEach(q => {
        if (q.topic) {
          const t = topicMap[q.topic?.toString()];
          if (t) t.questions.push(q);
          else uncategorized.questions.push(q);
        } else {
          uncategorized.questions.push(q);
        }
      });

      // Sort everything (optional)
      Object.values(topicMap).forEach(group => {
        group.materials.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
        group.assignments.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
        group.questions.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
      });
      uncategorized.materials.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
      uncategorized.assignments.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
      uncategorized.questions.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

      // Output
      let result = Object.values(topicMap);
      if (uncategorized.materials.length || uncategorized.assignments.length || uncategorized.questions.length)
        result = [...result, uncategorized];

      res.json(result);

    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

export default FeedRouter;
