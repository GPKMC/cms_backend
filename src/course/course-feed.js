import mongoose from "mongoose";
import express from "express";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import topicModel from "./topic-model.js";
import assignmentModel from "../assignment/assignmentModel.js";
import courseMaterialsModel from "./courseMaterials-model.js";

const FeedRouter = express.Router();

FeedRouter.get(
  "/:courseInstanceId",                   // <-- CORRECT route!
  authmiddleware,
  authorizedRole('teacher', 'student'),               // <-- fix role typo and allow student if needed
  async (req, res) => {
    const { courseInstanceId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(courseInstanceId))
      return res.status(400).json({ error: "Invalid courseInstanceId" });

    try {
      // 1. Fetch topics for the courseInstance
      const topics = await topicModel.find({ courseInstance: courseInstanceId }).lean();

      // 2. Fetch all materials and assignments for the courseInstance
    //   const [materials, assignments] = await Promise.all([
    //     courseMaterialsModel.find({ courseInstance: courseInstanceId })
    //       .populate("postedBy","username email")
    //       .lean(),
    //     assignmentModel.find({ courseInstance: courseInstanceId })
    //       .populate("postedBy", "username email")
    //       .lean(),
    //   ]);
    const [materials, assignments] = await Promise.all([
  courseMaterialsModel.find({ courseInstance: courseInstanceId })
    .populate("postedBy", "username email")
    .populate("visibleTo", "username email")
    .lean(),
  assignmentModel.find({ courseInstance: courseInstanceId })
    .populate("postedBy", "username email")
    .populate("visibleTo", "username email")
    .lean(),
]);


      // 3. Group by topic
      const topicMap = {};
      topics.forEach(topic => {
        topicMap[topic._id.toString()] = {
          topic,
          materials: [],
          assignments: [],
        };
      });

      // Handle Uncategorized (no topic)
      const uncategorized = {
        topic: { _id: null, title: "No topic" },
        materials: [],
        assignments: [],
      };

      // Group materials
      materials.forEach(mat => {
        if (mat.topic) {
          const t = topicMap[mat.topic?.toString()];
          if (t) t.materials.push(mat);
          else uncategorized.materials.push(mat); // topic was deleted maybe
        } else {
          uncategorized.materials.push(mat);
        }
      });

      // Group assignments
      assignments.forEach(assign => {
        if (assign.topic) {
          const t = topicMap[assign.topic?.toString()];
          if (t) t.assignments.push(assign);
          else uncategorized.assignments.push(assign);
        } else {
          uncategorized.assignments.push(assign);
        }
      });

      // Sort items within each topic (optional, newest first)
      Object.values(topicMap).forEach(group => {
        group.materials.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
        group.assignments.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
      });
      uncategorized.materials.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
      uncategorized.assignments.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

      // Combine groups for output
      let result = Object.values(topicMap);
      if (uncategorized.materials.length || uncategorized.assignments.length)
        result = [...result, uncategorized];

      res.json(result);

    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

export default FeedRouter;
