

// FeedRouter.get(
//   "/:courseInstanceId",
//   authmiddleware,
//   authorizedRole('teacher', 'student'),
//   async (req, res) => {
//     const { courseInstanceId } = req.params;
//     if (!mongoose.Types.ObjectId.isValid(courseInstanceId))
//       return res.status(400).json({ error: "Invalid courseInstanceId" });

//     try {
//       const topics = await topicModel.find({ courseInstance: courseInstanceId }).lean();

//       const [materials, assignments, questions] = await Promise.all([
//         courseMaterialsModel.find({ courseInstance: courseInstanceId })
//           .populate("postedBy", "username email")
//           .populate("visibleTo", "username email")
//           .lean(),
//         assignmentModel.find({ courseInstance: courseInstanceId })
//           .populate("postedBy", "username email")
//           .populate("visibleTo", "username email")
//           .lean(),
//         questionModel.find({ courseInstance: courseInstanceId })
//           .populate("postedBy", "username email")
//           .populate("visibleTo", "username email")
//           .lean(),
//       ]);

//       // Build topicMap with questions
//       const topicMap = {};
//       topics.forEach(topic => {
//         topicMap[topic._id.toString()] = {
//           topic,
//           materials: [],
//           assignments: [],
//           questions: []
//         };
//       });

//       const uncategorized = {
//         topic: { _id: null, title: "No topic" },
//         materials: [],
//         assignments: [],
//         questions: []
//       };

//       // Materials
//       materials.forEach(mat => {
//         if (mat.topic) {
//           const t = topicMap[mat.topic?.toString()];
//           if (t) t.materials.push(mat);
//           else uncategorized.materials.push(mat);
//         } else {
//           uncategorized.materials.push(mat);
//         }
//       });
//       // Assignments
//       assignments.forEach(assign => {
//         if (assign.topic) {
//           const t = topicMap[assign.topic?.toString()];
//           if (t) t.assignments.push(assign);
//           else uncategorized.assignments.push(assign);
//         } else {
//           uncategorized.assignments.push(assign);
//         }
//       });
//       // Questions
//       questions.forEach(q => {
//         if (q.topic) {
//           const t = topicMap[q.topic?.toString()];
//           if (t) t.questions.push(q);
//           else uncategorized.questions.push(q);
//         } else {
//           uncategorized.questions.push(q);
//         }
//       });

//       // Sort everything (optional)
//       Object.values(topicMap).forEach(group => {
//         group.materials.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
//         group.assignments.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
//         group.questions.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
//       });
//       uncategorized.materials.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
//       uncategorized.assignments.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
//       uncategorized.questions.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

//       // Output
//       let result = Object.values(topicMap);
//       if (uncategorized.materials.length || uncategorized.assignments.length || uncategorized.questions.length)
//         result = [...result, uncategorized];

//       res.json(result);

//     } catch (err) {
//       res.status(500).json({ error: err.message });
//     }
//   }
// );

// export default FeedRouter;

// import assignmentModel from "../assignment/assignmentModel.js";

// const FeedRouter = express.Router();


// Helper to bucket GroupAssignments, handling global vs per‑group overrides
// function bucketGroupAssignments(groupAssignments, arrName, topicMap, uncategorized) {
//   groupAssignments.forEach(asg => {
//     // detect any per‐group override
//     const hasOverride = asg.groups.some(g =>
//       Boolean(
//         g.title    || g.content ||
//         (g.media?.length    ?? 0) > 0 ||
//         (g.documents?.length?? 0) > 0 ||
//         (g.youtubeLinks?.length ?? 0) > 0 ||
//         (g.links?.length    ?? 0) > 0
//       )
//     );

//     if (!hasOverride) {
//       // CASE #1: no overrides → one global feed item
//       const feedItem = {
//         _id:          asg._id,
//         type:         "groupAssignment",
//         title:        asg.title,
//         content:      asg.content,
//         media:        asg.media,
//         documents:    asg.documents,
//         youtubeLinks: asg.youtubeLinks,
//         links:        asg.links,
//         groups:       asg.groups.map(g => ({
//           id:      g.id,
//           name:    g.name,
//           members: g.members
//         })),
//         postedBy:     asg.postedBy,
//         createdAt:    asg.createdAt,
//         updatedAt:    asg.updatedAt
//       };
//       const tid = asg.topic?.toString();
//       if (tid && topicMap[tid]) topicMap[tid][arrName].push(feedItem);
//       else uncategorized[arrName].push(feedItem);

//     } else {
//       // CASE #2: one feed item per group, merging overrides
//       asg.groups.forEach(g => {
//         const feedItem = {
//           _id:          `${asg._id}_${g.id}`,  // unique per-group
//           parentId:     asg._id,
//           type:         "groupAssignment",
//           groupName:    g.name,
//           title:        g.title    || asg.title,
//           content:      g.content  || asg.content,
//           media:        (g.media?.length    ? g.media    : asg.media)    || [],
//           documents:    (g.documents?.length? g.documents: asg.documents)|| [],
//           youtubeLinks: (g.youtubeLinks?.length? g.youtubeLinks : asg.youtubeLinks)|| [],
//           links:        (g.links?.length    ? g.links    : asg.links)    || [],
//           members:      g.members,
//           postedBy:     asg.postedBy,
//           createdAt:    asg.createdAt,
//           updatedAt:    asg.updatedAt
//         };
//         const tid = asg.topic?.toString();
//         if (tid && topicMap[tid]) topicMap[tid][arrName].push(feedItem);
//         else uncategorized[arrName].push(feedItem);
//       });
//     }
//   });
// }
import mongoose from "mongoose";
import express from "express";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import topicModel from "./topic-model.js";

import courseMaterialsModel from "./courseMaterials-model.js";
import questionModel from "../question/question-model.js";
import Assignment from "../assignment/assignmentModel.js";

const FeedRouter = express.Router();
import groupAssignmentModel from "../assignment/groupAssignment-model.js";
// Helper to bucket Materials / Assignments / Questions
function bucket(items, arrName, topicMap, uncategorized) {
  items.forEach(item => {
    const tid = item.topic?.toString();
    if (tid && topicMap[tid]) {
      topicMap[tid][arrName].push(item);
    } else {
      uncategorized[arrName].push(item);
    }
  });
}
function bucketGroupAssignments(groupAssignments, arrName, topicMap, uncategorized) {
  groupAssignments.forEach(asg => {
    // Always one feed item per assignment, with groups nested inside
    const feedItem = {
      _id: asg._id,
      type: "groupAssignment",
      title: asg.title,
      content: asg.content,
      media: asg.media,
      documents: asg.documents,
      youtubeLinks: asg.youtubeLinks,
      links: asg.links,
      groups: asg.groups, // ← pass all group info for frontend to handle
      postedBy: asg.postedBy,
      createdAt: asg.createdAt,
      updatedAt: asg.updatedAt
    };
    const tid = asg.topic?.toString();
    if (tid && topicMap[tid]) topicMap[tid][arrName].push(feedItem);
    else uncategorized[arrName].push(feedItem);
  });
}


FeedRouter.get(
  "/:courseInstanceId",
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    const { courseInstanceId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(courseInstanceId))
      return res.status(400).json({ error: "Invalid courseInstanceId" });

    try {
      // 1) fetch topics
      const topics = await topicModel
        .find({ courseInstance: courseInstanceId })
        .lean();

      // 2) fetch all four resource types in parallel
      const [materials, assignments, questions, groupAssignments] =
        await Promise.all([
          courseMaterialsModel
            .find({ courseInstance: courseInstanceId })
            .populate("postedBy", "username email")
            .populate("visibleTo", "username email")
            .lean(),
          Assignment
            .find({ courseInstance: courseInstanceId })
            .populate("postedBy", "username email")
            .populate("visibleTo", "username email")
            .lean(),
          questionModel
            .find({ courseInstance: courseInstanceId })
            .populate("postedBy", "username email")
            .populate("visibleTo", "username email")
            .lean(),
          groupAssignmentModel
            .find({ courseInstance: courseInstanceId })
            .populate("postedBy", "username email")
            .lean(),
        ]);

      // 3) build topicMap
      const topicMap = {};
      topics.forEach(topic => {
        topicMap[topic._id.toString()] = {
          topic,
          materials: [],
          assignments: [],
          questions: [],
          groupAssignments: []    // ← new bucket
        };
      });

      // 4) uncategorized bucket
      const uncategorized = {
        topic: { _id: null, title: "No topic" },
        materials: [],
        assignments: [],
        questions: [],
        groupAssignments: []
      };

      // 5) bucket everything
      bucket(materials, "materials", topicMap, uncategorized);
      bucket(assignments, "assignments", topicMap, uncategorized);
      bucket(questions, "questions", topicMap, uncategorized);
      bucketGroupAssignments(groupAssignments, "groupAssignments", topicMap, uncategorized);

      // 6) sort each array by date desc
      const sortByDate = (a, b) =>
        new Date(b.updatedAt || b.createdAt) -
        new Date(a.updatedAt || a.createdAt);

      Object.values(topicMap).forEach(g => {
        g.materials.sort(sortByDate);
        g.assignments.sort(sortByDate);
        g.questions.sort(sortByDate);
        g.groupAssignments.sort(sortByDate);
      });
      uncategorized.materials.sort(sortByDate);
      uncategorized.assignments.sort(sortByDate);
      uncategorized.questions.sort(sortByDate);
      uncategorized.groupAssignments.sort(sortByDate);

      // 7) assemble final result
      let result = Object.values(topicMap);
      if (
        uncategorized.materials.length ||
        uncategorized.assignments.length ||
        uncategorized.questions.length ||
        uncategorized.groupAssignments.length
      ) {
        result.push(uncategorized);
      }

      res.json(result);

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

export default FeedRouter;
