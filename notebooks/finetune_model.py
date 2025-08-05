# import random
# from pymongo import MongoClient
# from sentence_transformers import SentenceTransformer, InputExample, losses
# from torch.utils.data import DataLoader

# # ------------------ CONFIG -------------------
# MONGO_URI = "mongodb+srv://karkibipl:biplovkarki@cmsdatabase.kznvlq9.mongodb.net/"
# DB_NAME = "test"
# BASE_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
# MODEL_SAVE_PATH = "my-finetuned-model"
# EPOCHS = 2
# BATCH_SIZE = 16
# # ---------------------------------------------

# # 1. Connect to MongoDB
# client = MongoClient(MONGO_URI)
# db = client[DB_NAME]

# # 2. Load texts from your collections (edit collection names as needed)
# texts = []
# for sub in db.submissions.find({}):
#     if sub.get("combinedText"):
#         texts.append(sub["combinedText"])
# for q in db.questionsubmissions.find({}):
#     if q.get("answerText"):
#         texts.append(q["answerText"])
# # Double-check your collection name here (case sensitive!):
# if "groupassignmentsubmission" in db.list_collection_names():
#     groupassignments = db.groupassignmentsubmission.find()
# elif "groupassignments" in db.list_collection_names():
#     groupassignments = db.groupassignments.find()
# else:
#     groupassignments = []
# for ga in groupassignments:
#     for group in ga.get("groups", []):
#         for gsub in group.get("submissions", []):
#             if gsub.get("combinedText"):
#                 texts.append(gsub["combinedText"])
# for ref in db.references.find({}):
#     if ref.get("text"):
#         texts.append(ref["text"])

# print(f"Total texts loaded: {len(texts)}")
# if len(texts) < 2:
#     raise ValueError("Not enough texts in the database to fine-tune!")

# # 3. Prepare training pairs (positive & negative)
# pairs = []
# for i, t1 in enumerate(texts):
#     # Positive pair (same text)
#     pairs.append(InputExample(texts=[t1, t1], label=1.0))
#     # Negative pair (different text)
#     neg_indices = list(range(len(texts)))
#     neg_indices.remove(i)
#     if neg_indices:  # make sure there's another text!
#         j = random.choice(neg_indices)
#         pairs.append(InputExample(texts=[t1, texts[j]], label=0.0))

# random.shuffle(pairs)
# print(f"Total training pairs: {len(pairs)}")

# # 4. Prepare DataLoader and model
# train_dataloader = DataLoader(pairs, shuffle=True, batch_size=BATCH_SIZE)
# model = SentenceTransformer(BASE_MODEL)
# train_loss = losses.CosineSimilarityLoss(model)

# # 5. Fine-tune
# print("Starting model fine-tuning...")
# model.fit(
#     train_objectives=[(train_dataloader, train_loss)],
#     epochs=EPOCHS,
#     warmup_steps=100,
#     show_progress_bar=True
# )

# # 6. Save the model
# model.save(MODEL_SAVE_PATH)
# print(f"Model saved at {MODEL_SAVE_PATH}")

# # 7. (Optional) Print sample pair for verification
# sample = pairs[0]
# print("\nSample pair for training:")
# print(f"Text 1: {sample.texts[0][:100]}...")
# print(f"Text 2: {sample.texts[1][:100]}...")
# print(f"Label: {sample.label}")
