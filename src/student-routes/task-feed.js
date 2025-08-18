import express from "express";
import groupAssignmentModel from "../assignment/groupAssignment-model.js";
import assignmentModel from "../assignment/assignmentModel.js";
import quizquestionModel from "../quizQuestion/quizquestion-model.js";
import questionModel from "../question/question-model.js";

const taskRouter = express.Router();

/**
 * GET /api/feed/:courseInstanceId
 * Optional query params:
 *   - topic: topicId (string)
 *   - type: assignment|groupAssignment|quiz|question (string or array)
 */
taskRouter.get("/feed/:courseInstanceId", async (req, res) => {
  const { courseInstanceId } = req.params;
  const { topic, type } = req.query;

  // Topic filter: only include topic if provided
  const topicFilter = topic ? { topic } : {};

  // Determine which types to include in the feed
  const typeArr = type
    ? Array.isArray(type)
      ? type
      : [type]
    : ["assignment", "groupAssignment", "quiz", "question"];

  try {
    // Fetch all models in parallel according to filter
    const promises = [];

    if (typeArr.includes("assignment")) {
      promises.push(
        assignmentModel
          .find({
            courseInstance: courseInstanceId,
            ...topicFilter,
          })
          .populate("postedBy", "username role _id")
          .populate("topic", "title _id")
          .lean()
          .then((items) =>
            items.map((a) => ({
              ...a,
              type: "assignment",
            }))
          )
      );
    }

    if (typeArr.includes("groupAssignment")) {
      promises.push(
        groupAssignmentModel
          .find({
            courseInstance: courseInstanceId,
            ...topicFilter,
          })
          .populate("postedBy", "username role _id")
          .populate("topic", "title _id")
          .populate("groups.members", "username _id role")
          .lean()
          .then((items) =>
            items.map((a) => ({
              ...a,
              type: "groupAssignment",
            }))
          )
      );
    }

    if (typeArr.includes("quiz")) {
      // 🔒 Only include published quizzes
      const publishedOnly = { $or: [{ published: true }, { isPublished: true }] };

      promises.push(
        quizquestionModel
          .find({
            courseInstance: courseInstanceId,
            ...topicFilter, // keep if your quiz schema actually has "topic"
            ...publishedOnly,
          })
          .populate("postedBy", "username role _id")
          .populate("topic", "title _id") // keep only if quiz has a topic ref
          .lean()
          .then((items) =>
            items.map((a) => ({
              ...a,
              type: "quiz",
            }))
          )
      );
    }

    if (typeArr.includes("question")) {
      promises.push(
        questionModel
          .find({
            courseInstance: courseInstanceId,
            ...topicFilter,
          })
          .populate("postedBy", "username role _id")
          .populate("topic", "title _id")
          .lean()
          .then((items) =>
            items.map((a) => ({
              ...a,
              type: "question",
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

    // Normalize the output shape for frontend consumption
    feed = feed.map((item) => ({
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
      // Extra details for certain types
      ...(item.type === "groupAssignment" ? { groups: item.groups } : {}),
      ...(item.type === "quiz" ? { questions: item.questions } : {}),
    }));

    res.json(feed);
  } catch (err) {
    console.error("Feed fetch error:", err);
    res.status(500).json({ error: "Could not fetch unified feed." });
  }
});

export default taskRouter;
