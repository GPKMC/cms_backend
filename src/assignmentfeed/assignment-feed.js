import express from "express";
import assignmentModel from "../assignment/assignmentModel.js";
import groupAssignmentModel from "../assignment/groupAssignment-model.js";
import quizquestionModel from "../quizQuestion/quizquestion-model.js";
import questionModel from "../question/question-model.js";
import CourseInstance from "../course/courseinstance-model.js";
const AssignmentFeedRouter = express.Router();

/**
 * GET /api/feed/all
 * Query params:
 *   - batch: (e.g. 2020)
 *   - semester: (e.g. 5)
 *   - topic: topicId (optional)
 *   - type: assignment|groupAssignment|quiz|question (string or array, optional)
 *   - groupBy: 'courseInstance' | 'flat' (optional, default flat)
 */
AssignmentFeedRouter.get("/feed/all", async (req, res) => {
  const { batch, semester, topic, type, groupBy } = req.query;

  if (!batch || !semester) {
    return res.status(400).json({ error: "batch and semester are required" });
  }

  // Filter courseInstances by batch and semester
  const courseInstanceFilter = { batch, semester };
  const courseInstances = await CourseInstance.find(courseInstanceFilter).lean();

  if (!courseInstances.length)
    return res.json([]);

  // Prepare feed queries for each courseInstance
  const typeArr = type
    ? Array.isArray(type)
      ? type
      : [type]
    : ["assignment", "groupAssignment", "quiz", "question"];

  // Prepare topic filter if provided
  const topicFilter = topic ? { topic } : {};

  // Helper to fetch feed for one courseInstance
  async function fetchFeedForCI(ci) {
    const promises = [];

    if (typeArr.includes("assignment")) {
      promises.push(
        assignmentModel.find({
          courseInstance: ci._id,
          ...topicFilter,
        })
          .populate("postedBy", "username role _id")
          .populate("topic", "title _id")
          .lean()
          .then(items =>
            items.map(a => ({
              ...a,
              type: "assignment",
              courseInstance: { _id: ci._id, name: ci.name || "", batch: ci.batch, semester: ci.semester }
            }))
          )
      );
    }

    if (typeArr.includes("groupAssignment")) {
      promises.push(
        groupAssignmentModel.find({
          courseInstance: ci._id,
          ...topicFilter,
        })
          .populate("postedBy", "username role _id")
          .populate("topic", "title _id")
          .populate("groups.members", "username _id role")
          .lean()
          .then(items =>
            items.map(a => ({
              ...a,
              type: "groupAssignment",
              courseInstance: { _id: ci._id, name: ci.name || "", batch: ci.batch, semester: ci.semester }
            }))
          )
      );
    }

    if (typeArr.includes("quiz")) {
      promises.push(
        quizquestionModel.find({
          courseInstance: ci._id,
          ...topicFilter,
        })
          .populate("postedBy", "username role _id")
          .populate("topic", "title _id")
          .lean()
          .then(items =>
            items.map(a => ({
              ...a,
              type: "quiz",
              courseInstance: { _id: ci._id, name: ci.name || "", batch: ci.batch, semester: ci.semester }
            }))
          )
      );
    }

    if (typeArr.includes("question")) {
      promises.push(
        questionModel.find({
          courseInstance: ci._id,
          ...topicFilter,
        })
          .populate("postedBy", "username role _id")
          .populate("topic", "title _id")
          .lean()
          .then(items =>
            items.map(a => ({
              ...a,
              type: "question",
              courseInstance: { _id: ci._id, name: ci.name || "", batch: ci.batch, semester: ci.semester }
            }))
          )
      );
    }

    // Await all, flatten
    const results = await Promise.all(promises);
    let feed = results.flat();

    // Sort by updatedAt (fallback to createdAt if missing)
    feed = feed.sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)
    );

    // Normalize the output shape for frontend
    feed = feed.map(item => ({
      _id: item._id,
      type: item.type,
      title: item.title,
      content: item.content || item.description || "",
      postedBy: item.postedBy,
      topic: item.topic || null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      dueDate: item.dueDate || null,
      points: item.points || 0,
      documents: item.documents || [],
      media: item.media || [],
      youtubeLinks: item.youtubeLinks || [],
      links: item.links || [],
      courseInstance: item.courseInstance,
      ...(item.type === "groupAssignment" ? { groups: item.groups } : {}),
      ...(item.type === "quiz" ? { questions: item.questions } : {}),
    }));

    return feed;
  }

  // For all courseInstances in parallel
  const allFeeds = await Promise.all(courseInstances.map(fetchFeedForCI));

  // groupBy=courseInstance will give you one array per courseInstance
  if (groupBy === "courseInstance") {
    // [{courseInstance, feed: [...]}, ...]
    const grouped = courseInstances.map((ci, idx) => ({
      courseInstance: {
        _id: ci._id,
        name: ci.name || "",
        batch: ci.batch,
        semester: ci.semester,
      },
      feed: allFeeds[idx],
    }));
    return res.json(grouped);
  }

  // else return one big flat array
  return res.json(allFeeds.flat());
});

export default AssignmentFeedRouter;
