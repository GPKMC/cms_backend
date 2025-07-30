import mongoose from "mongoose";
import express from "express";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import topicModel from "../course/topic-model.js";
import courseMaterialsModel from "../course/courseMaterials-model.js";


const StudentFeedRouter = express.Router();

StudentFeedRouter.get(
  "/materials/:courseInstanceId",
  authmiddleware,
  authorizedRole("student"),
  async (req, res) => {
    const { courseInstanceId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(courseInstanceId))
      return res.status(400).json({ error: "Invalid courseInstanceId" });

    try {
      // 1. Fetch topics for the course instance
      const topics = await topicModel
        .find({ courseInstance: courseInstanceId })
        .lean();

      // 2. Fetch all materials for the course instance (with postedBy and visibleTo populated)
      const materials = await courseMaterialsModel
        .find({ courseInstance: courseInstanceId })
        .populate("postedBy", "username email")
        .populate("visibleTo", "_id username email")
        .lean();

      // 3. Filter materials: only include those visible to the current student
      const userId = req.user._id.toString();
      const filteredMaterials = materials.filter(mat => {
        if (!mat.visibleTo || mat.visibleTo.length === 0) return true; // public to all
        // visibleTo may be array of populated objects or ObjectIds
        return mat.visibleTo.some(
          (u) => (u._id?.toString?.() || u.toString?.()) === userId
        );
      });

      // 4. Build topicMap for grouping
      const topicMap = {};
      topics.forEach(topic => {
        topicMap[topic._id.toString()] = {
          topic,
          materials: [],
        };
      });

      // 5. Uncategorized bucket
      const uncategorized = {
        topic: { _id: null, title: "No topic" },
        materials: []
      };

      // 6. Bucket materials by topic
      filteredMaterials.forEach(mat => {
        const tid = mat.topic?.toString();
        if (tid && topicMap[tid]) {
          topicMap[tid].materials.push(mat);
        } else {
          uncategorized.materials.push(mat);
        }
      });

      // 7. Sort each materials array by updatedAt > createdAt (descending)
      const sortByDate = (a, b) =>
        new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);

      Object.values(topicMap).forEach(g => {
        g.materials.sort(sortByDate);
      });
      uncategorized.materials.sort(sortByDate);

      // 8. Assemble result (topics + uncategorized if present)
      let result = Object.values(topicMap);
      if (uncategorized.materials.length) {
        result.push(uncategorized);
      }

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);



export default StudentFeedRouter;
