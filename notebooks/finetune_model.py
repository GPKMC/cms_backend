import random
from pymongo import MongoClient
from sentence_transformers import SentenceTransformer, InputExample, losses
from torch.utils.data import DataLoader

# Config
MONGO_URI = "mongodb+srv://karkibipl:biplovkarki@cmsdatabase.kznvlq9.mongodb.net/"
DB_NAME = "test"
BASE_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
MODEL_SAVE_PATH = "my-finetuned-model"
EPOCHS = 2
BATCH_SIZE = 16

# Connect to MongoDB
client = MongoClient(MONGO_URI)
db = client[DB_NAME]

# Load texts from your collections
texts = []
for sub in db.submissions.find({}):
    if sub.get("combinedText"):
        texts.append(sub["combinedText"])
for q in db.questionsubmissions.find({}):
    if q.get("answerText"):
        texts.append(q["answerText"])
for ga in db.GroupAssignmentSubmission.find({}):
    for group in ga.get("groups", []):
        for gsub in group.get("submissions", []):
            if gsub.get("combinedText"):
                texts.append(gsub["combinedText"])
for ref in db.references.find({}):
    if ref.get("text"):
        texts.append(ref["text"])

print(f"Total texts loaded: {len(texts)}")

# Prepare training pairs
pairs = []
for i, t1 in enumerate(texts):
    # Positive pair (same text)
    pairs.append(InputExample(texts=[t1, t1], label=1.0))
    # Negative pair (different texts)
    j = random.randint(0, len(texts) - 1)
    if j != i:
        pairs.append(InputExample(texts=[t1, texts[j]], label=0.0))

# DataLoader and model
train_dataloader = DataLoader(pairs, shuffle=True, batch_size=BATCH_SIZE)
model = SentenceTransformer(BASE_MODEL)
train_loss = losses.CosineSimilarityLoss(model)

# Fine-tune
model.fit(
    train_objectives=[(train_dataloader, train_loss)],
    epochs=EPOCHS,
    warmup_steps=100
)

# Save your fine-tuned model
model.save(MODEL_SAVE_PATH)
print(f"Model saved at {MODEL_SAVE_PATH}")
