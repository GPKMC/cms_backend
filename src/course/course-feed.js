//this file is for fetching all types of assignment based on topic and this is for teacher only
import mongoose from "mongoose";
import express from "express";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import topicModel from "./topic-model.js";

import courseMaterialsModel from "./courseMaterials-model.js";
import questionModel from "../question/question-model.js";
import Assignment from "../assignment/assignmentModel.js";
import groupAssignmentModel from "../assignment/groupAssignment-model.js";
import quizquestionModel from "../quizQuestion/quizquestion-model.js";

const FeedRouter = express.Router();

/** Generic bucketer for materials/assignments/questions/quizzes */
function bucket(items, arrName, topicMap, uncategorized) {
  items.forEach((item) => {
    const tid = item.topic?.toString();
    if (tid && topicMap[tid]) topicMap[tid][arrName].push(item);
    else uncategorized[arrName].push(item);
  });
}

/** Bucketer for group assignments: one feed item per GA, with nested groups */
function bucketGroupAssignments(groupAssignments, arrName, topicMap, uncategorized) {
  groupAssignments.forEach((asg) => {
    const feedItem = {
      _id: asg._id,
      type: "groupAssignment",
      title: asg.title,
      content: asg.content,
      media: asg.media,
      documents: asg.documents,
      youtubeLinks: asg.youtubeLinks,
      links: asg.links,
      groups: asg.groups, // entire groups array; front-end can decide how to display
      groupCount: Array.isArray(asg.groups) ? asg.groups.length : 0,
      postedBy: asg.postedBy,
      createdAt: asg.createdAt,
      updatedAt: asg.updatedAt,
      topic: asg.topic,
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
    if (!mongoose.Types.ObjectId.isValid(courseInstanceId)) {
      return res.status(400).json({ error: "Invalid courseInstanceId" });
    }

    const isTeacher = req.user?.role === "teacher";
    const userId = req.user?._id?.toString?.();

    try {
      // 1) Topics (shared)
      const topics = await topicModel.find({ courseInstance: courseInstanceId }).lean();

      // 2) Build per-role queries
      // Teachers: see everything within the courseInstance
      const baseCourseFilter = { courseInstance: courseInstanceId };

      // Students: public (no visibleTo) OR includes the student id
      // NOTE: $size:0 only matches [] when the field exists; pair with $exists:false.
      const visibleToFilter = isTeacher
        ? {} // no visibility restriction for teachers
        : {
            $or: [
              { visibleTo: { $exists: false } },
              { visibleTo: { $size: 0 } },
              { visibleTo: userId }, // Mongoose will cast userId to ObjectId
            ],
          };

      // Group assignments:
      // Teachers: all group assignments in the course.
      // Students: only group assignments where any group's members include the student.
      const groupAssignmentFilter = isTeacher
        ? baseCourseFilter
        : { ...baseCourseFilter, "groups.members": userId };

      // 3) Fetch everything in parallel (role-aware)
      let [materials, assignments, questions, groupAssignments, quizzes] = await Promise.all([
        courseMaterialsModel
          .find({ ...baseCourseFilter, ...visibleToFilter })
          .populate("postedBy", "username email")
          .populate("visibleTo", "_id")
          .lean(),
        Assignment.find({ ...baseCourseFilter, ...visibleToFilter })
          .populate("postedBy", "username email")
          .populate("visibleTo", "_id")
          .lean(),
        questionModel
          .find({ ...baseCourseFilter, ...visibleToFilter })
          .populate("postedBy", "username email")
          .populate("visibleTo", "_id")
          .lean(),
        groupAssignmentModel
          .find(groupAssignmentFilter)
          .populate("postedBy", "username email")
          .lean(),
        quizquestionModel
          .find({ ...baseCourseFilter, ...visibleToFilter })
          .populate("postedBy", "username email")
        
          .lean(),
      ]);

      // 4) Add visibleCount (for everything that has visibleTo)
      const withVisibleCount = (items) =>
        items.map((i) => ({
          ...i,
          visibleCount: Array.isArray(i.visibleTo) ? i.visibleTo.length : 0,
        }));

      materials = withVisibleCount(materials);
      assignments = withVisibleCount(assignments);
      questions = withVisibleCount(questions);
      quizzes = withVisibleCount(quizzes);
      // (groupAssignments usually don't have visibleTo)

      // 5) Build topic map
      const topicMap = {};
      topics.forEach((t) => {
        topicMap[t._id.toString()] = {
          topic: t,
          materials: [],
          assignments: [],
          questions: [],
          groupAssignments: [],
          quizzes: [],
        };
      });

      // 6) Uncategorized bucket
      const uncategorized = {
        topic: { _id: null, title: "No topic" },
        materials: [],
        assignments: [],
        questions: [],
        groupAssignments: [],
        quizzes: [],
      };

      // 7) Bucket all
      bucket(materials, "materials", topicMap, uncategorized);
      bucket(assignments, "assignments", topicMap, uncategorized);
      bucket(questions, "questions", topicMap, uncategorized);
      bucketGroupAssignments(groupAssignments, "groupAssignments", topicMap, uncategorized);
      bucket(quizzes, "quizzes", topicMap, uncategorized);

      // 8) Sort by last activity desc
      const sortByDateDesc = (a, b) =>
        new Date(b.updatedAt || b.createdAt).getTime() -
        new Date(a.updatedAt || a.createdAt).getTime();

      Object.values(topicMap).forEach((group) => {
        group.materials.sort(sortByDateDesc);
        group.assignments.sort(sortByDateDesc);
        group.questions.sort(sortByDateDesc);
        group.groupAssignments.sort(sortByDateDesc);
        group.quizzes.sort(sortByDateDesc);
      });
      uncategorized.materials.sort(sortByDateDesc);
      uncategorized.assignments.sort(sortByDateDesc);
      uncategorized.questions.sort(sortByDateDesc);
      uncategorized.groupAssignments.sort(sortByDateDesc);
      uncategorized.quizzes.sort(sortByDateDesc);

      // 9) Assemble result (include uncategorized if non-empty)
      let result = Object.values(topicMap);
      if (
        uncategorized.materials.length ||
        uncategorized.assignments.length ||
        uncategorized.questions.length ||
        uncategorized.groupAssignments.length ||
        uncategorized.quizzes.length
      ) {
        result = [...result, uncategorized];
      }

      res.json(result);
    } catch (err) {
      console.error("Feed error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

export default FeedRouter;
