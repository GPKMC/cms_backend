import os
import re
import numpy as np
import fitz  # PyMuPDF
from pymongo import MongoClient
from sentence_transformers import SentenceTransformer, InputExample, losses
from torch.utils.data import DataLoader
from pdf2image import convert_from_path
from docx import Document
import textract
from urllib.parse import urlparse
from google.cloud import vision
from nltk.tokenize import sent_tokenize  # sentence tokenizer
import random

# Set path to your Google Vision credentials JSON file
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = r"c:\Users\zenit\Downloads\winter-rider-437615-e5-1f4432809731.json"

# Config
MONGO_URI = "mongodb+srv://karkibipl:biplovkarki@cmsdatabase.kznvlq9.mongodb.net/"
DB_NAME = "test"

MODEL_PATH = "my-finetuned-model"
BASE_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

PLAG_THRESHOLD = 0.3  # Base threshold 30%
MIN_SENTENCE_LENGTH = 10  # Minimum words to consider a sentence valid
MIN_SIMILARITY_SHORT = 0.85  # Higher threshold for short sentences

BATCH_SIZE = 16
EPOCHS = 2

# Init
client = MongoClient(MONGO_URI)
db = client[DB_NAME]
vision_client = vision.ImageAnnotatorClient()

if os.path.exists(MODEL_PATH):
    model = SentenceTransformer(MODEL_PATH)
else:
    model = SentenceTransformer(BASE_MODEL)

def google_vision_ocr(image_path: str) -> str:
    with open(image_path, "rb") as image_file:
        content = image_file.read()
    image = vision.Image(content=content)
    response = vision_client.document_text_detection(image=image)
    if response.error.message:
        raise Exception(f'Google Vision API error: {response.error.message}')
    return response.full_text_annotation.text

def extract_sentences_with_positions_pdf(filepath: str):
    doc = fitz.open(filepath)
    results = []
    for page_num in range(len(doc)):
        page = doc[page_num]
        blocks = page.get_text("blocks")
        for block in blocks:
            block_text = block[4].strip()
            if not block_text:
                continue
            sentences = sent_tokenize(block_text)
            if len(sentences) == 1:
                results.append({
                    "page": page_num + 1,
                    "bbox": (block[0], block[1], block[2], block[3]),
                    "text": sentences[0]
                })
            else:
                total_height = block[3] - block[1]
                sentence_height = total_height / len(sentences)
                for i, sentence in enumerate(sentences):
                    y0 = block[1] + i * sentence_height
                    y1 = y0 + sentence_height
                    results.append({
                        "page": page_num + 1,
                        "bbox": (block[0], y0, block[2], y1),
                        "text": sentence
                    })
    return results

def extract_text_from_file(filepath: str, filetype: str) -> str:
    if filetype is None and filepath.lower().endswith('.pdf'):
        filetype = "application/pdf"
    try:
        if filetype and "image" in filetype:
            return google_vision_ocr(filepath)
        elif filetype in ["application/pdf", "pdf"]:
            sentences_with_pos = extract_sentences_with_positions_pdf(filepath)
            if sentences_with_pos:
                return "\n".join([s["text"] for s in sentences_with_pos])
            else:
                print("[DEBUG] No text layer found, OCR fallback...")
                # Implement OCR fallback if needed
                return ""
        elif filetype in ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"]:
            doc = Document(filepath)
            return "\n".join([para.text for para in doc.paragraphs])
        elif filetype in ["text/plain", "txt"]:
            with open(filepath, encoding="utf-8") as f:
                return f.read()
        else:
            return textract.process(filepath).decode("utf-8")
    except Exception as e:
        print(f"Could not extract text from {filepath}: {e}")
        return ""

def extract_and_store_urls(text: str) -> None:
    urls = re.findall(r"https?://[^\s]+", text)
    for url in urls:
        exists = db.references.find_one({"source_url": url})
        if not exists:
            db.references.insert_one({
                "type": "website",
                "title": urlparse(url).netloc,
                "source_url": url,
                "text": "",
                "embedding": []
            })

def embed_text(texts):
    if isinstance(texts, str):
        return model.encode([texts]).tolist()[0]
    return model.encode(texts).tolist()

def cosine_sim(a, b) -> float:
    a = np.array(a)
    b = np.array(b)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-8))

def flatten_group_submissions(group_assignments):
    group_subs = []
    for ga in group_assignments:
        for group in ga.get("groups", []):
            for gsub in group.get("submissions", []):
                if "embedding" not in gsub:
                    gsub["embedding"] = []
                group_subs.append({
                    "text": gsub.get("combinedText", ""),
                    "embedding": gsub.get("embedding", []),
                    "student": gsub.get("submittedBy"),
                    "_id": gsub.get("_id")
                })
    return group_subs

def load_all_pools():
    submissions = list(db.submissions.find({}))
    pool_subs = [{
        "text": sub.get("combinedText", ""),
        "embedding": sub.get("embedding", []),
        "student": sub.get("student") or sub.get("submittedBy"),
        "_id": sub.get("_id")
    } for sub in submissions]

    question_submissions = list(db.questionsubmissions.find({}))
    pool_subs += [{
        "text": sub.get("answerText", ""),
        "embedding": sub.get("embedding", []),
        "student": sub.get("student") or sub.get("submittedBy"),
        "_id": sub.get("_id")
    } for sub in question_submissions]

    group_assignments = list(db.groupassignments.find({}))
    pool_subs += flatten_group_submissions(group_assignments)

    references = list(db.references.find({}))
    pool_refs = [{
        "text": ref.get("text", ""),
        "embedding": ref.get("embedding", []),
        "_id": ref.get("_id")
    } for ref in references]

    return pool_subs, pool_refs

def is_valid_sentence(text):
    words = text.split()
    if len(words) < 3:
        return False
    return True

def dynamic_similarity_threshold(sentence):
    word_count = len(sentence.split())
    if word_count < MIN_SENTENCE_LENGTH:
        return MIN_SIMILARITY_SHORT
    return PLAG_THRESHOLD

def check_plagiarism(
    filepaths=None,
    filetypes=None,
    student_id=None,
    text_input=None,
    current_submission_id=None,
    auto_save=True
):
    if filepaths is None:
        filepaths = []
    if filetypes is None:
        filetypes = [None] * len(filepaths)

    all_texts = []
    submission_sentences_with_pos = []

    # Extract and split sentences from files
    for i, filepath in enumerate(filepaths):
        if os.path.exists(filepath):
            filetype = filetypes[i] if i < len(filetypes) else None
            extracted_text = extract_text_from_file(filepath, filetype)
            if not extracted_text.strip():
                print(f"[DEBUG] No text extracted from file: {filepath}")
                continue
            sentences = [s.strip() for s in sent_tokenize(extracted_text) if s.strip()]
            for s in sentences:
                if is_valid_sentence(s):
                    submission_sentences_with_pos.append({"page": None, "bbox": None, "text": s})
            all_texts.append(extracted_text)

    # Handle plain text input
    if text_input:
        sentences = [s.strip() for s in sent_tokenize(text_input) if s.strip()]
        for s in sentences:
            if is_valid_sentence(s):
                submission_sentences_with_pos.append({"page": None, "bbox": None, "text": s})
        all_texts.append(text_input)

    full_text = "\n".join(all_texts).strip()
    extract_and_store_urls(full_text)

    if not full_text:
        print("[DEBUG] No text extracted from submission.")
        return {
            "status": "EMPTY_INPUT",
            "message": "No text was extracted from the provided files or input.",
            "plagiarism": 0,
            "matches": []
        }

    print(f"[DEBUG] Total submission sentences: {len(submission_sentences_with_pos)}")
    submission_texts = [sp["text"] for sp in submission_sentences_with_pos]
    submission_embeddings = embed_text(submission_texts)
    print(f"[DEBUG] Submission embeddings count: {len(submission_embeddings)}")

    pool_subs, pool_refs = load_all_pools()
    print(f"[DEBUG] Loaded {len(pool_subs)} submissions from DB for comparison.")
    print(f"[DEBUG] Loaded {len(pool_refs)} reference documents from DB.")

    matches = []

    # Check similarity against references
    for ref in pool_refs:
        if not ref.get("text"):
            continue
        ref_sentences = [s.strip() for s in sent_tokenize(ref["text"]) if s.strip()]
        ref_sentences = [s for s in ref_sentences if is_valid_sentence(s)]
        if not ref_sentences:
            continue
        ref_embeddings = embed_text(ref_sentences)
        for i, sub_emb in enumerate(submission_embeddings):
            threshold = dynamic_similarity_threshold(submission_texts[i])
            for j, ref_emb in enumerate(ref_embeddings):
                sim = cosine_sim(sub_emb, ref_emb)
                if sim >= threshold:
                    matches.append({
                        "type": "reference",
                        "source_id": str(ref["_id"]),
                        "similarity": sim,
                        "matched_text": submission_texts[i],
                        "source_text": ref_sentences[j],
                        "page": submission_sentences_with_pos[i].get("page"),
                        "bbox": submission_sentences_with_pos[i].get("bbox"),
                    })

    # Check similarity against other submissions
    for other in pool_subs:
        if current_submission_id and other.get("_id") == current_submission_id:
            continue
        if student_id and other.get("student") == student_id:
            continue
        if not other.get("text"):
            continue
        other_sentences = [s.strip() for s in sent_tokenize(other["text"]) if s.strip()]
        other_sentences = [s for s in other_sentences if is_valid_sentence(s)]
        if not other_sentences:
            continue
        other_embeddings = embed_text(other_sentences)
        for i, sub_emb in enumerate(submission_embeddings):
            threshold = dynamic_similarity_threshold(submission_texts[i])
            for j, other_emb in enumerate(other_embeddings):
                sim = cosine_sim(sub_emb, other_emb)
                if sim >= threshold:
                    matches.append({
                        "type": "submission",
                        "source_id": str(other["_id"]),
                        "similarity": sim,
                        "matched_text": submission_texts[i],
                        "source_text": other_sentences[j],
                        "page": submission_sentences_with_pos[i].get("page"),
                        "bbox": submission_sentences_with_pos[i].get("bbox"),
                    })

    # Calculate plagiarism percentage using unique matched sentences
    matched_sentences = set(m["matched_text"] for m in matches)
    plag_percent = (len(matched_sentences) / max(len(submission_texts), 1)) * 100
    matches = sorted(matches, key=lambda x: x["similarity"], reverse=True)[:10]

    print(f"[DEBUG] Plagiarism percentage: {plag_percent:.2f}%")
    print(f"[DEBUG] Total matches found: {len(matches)}")

    if plag_percent < PLAG_THRESHOLD * 100:
        if auto_save and full_text:
            db.submissions.insert_one({
                "student": student_id,
                "combinedText": full_text,
                "sentences": [
                    {
                        "text": sp["text"],
                        "page": sp.get("page"),
                        "bbox": sp.get("bbox"),
                        "embedding": emb
                    }
                    for sp, emb in zip(submission_sentences_with_pos, submission_embeddings)
                ],
                "plagiarismPercentage": plag_percent,
                "matches": matches
            })
        print("[DEBUG] Submission accepted and saved.")
        return {
            "status": "ACCEPTED",
            "plagiarism": plag_percent,
            "matches": matches
        }
    else:
        print("[DEBUG] Submission flagged as plagiarized.")
        return {
            "status": "PLAGIARIZED",
            "plagiarism": plag_percent,
            "matches": matches
        }

def train_model_automatic():
    texts = []
    for sub in db.submissions.find({}):
        if sub.get("combinedText"):
            texts.append(sub["combinedText"])
    for q in db.questionsubmissions.find({}):
        if q.get("answerText"):
            texts.append(q["answerText"])
    groupassignments = []
    if "groupassignments" in db.list_collection_names():
        groupassignments = db.groupassignments.find()
    for ga in groupassignments:
        for group in ga.get("groups", []):
            for gsub in group.get("submissions", []):
                if gsub.get("combinedText"):
                    texts.append(gsub["combinedText"])
    for ref in db.references.find({}):
        if ref.get("text"):
            texts.append(ref["text"])

    print(f"[DEBUG] Total texts loaded for training: {len(texts)}")
    if len(texts) < 2:
        print("[DEBUG] Not enough texts to fine-tune.")
        return

    pairs = []
    for i, t1 in enumerate(texts):
        pairs.append(InputExample(texts=[t1, t1], label=1.0))
        neg_indices = list(range(len(texts)))
        neg_indices.remove(i)
        if neg_indices:
            j = random.choice(neg_indices)
            pairs.append(InputExample(texts=[t1, texts[j]], label=0.0))

    random.shuffle(pairs)
    print(f"[DEBUG] Total training pairs: {len(pairs)}")

    train_dataloader = DataLoader(pairs, shuffle=True, batch_size=BATCH_SIZE)
    train_loss = losses.CosineSimilarityLoss(model)

    print("[DEBUG] Starting model fine-tuning...")
    model.fit(
        train_objectives=[(train_dataloader, train_loss)],
        epochs=EPOCHS,
        warmup_steps=100,
        show_progress_bar=True
    )

    model.save(MODEL_PATH)
    print(f"[DEBUG] Model saved at {MODEL_PATH}")

# Example usage
if __name__ == "__main__":
    # Example plagiarism check
    result = check_plagiarism(
        filepaths=[r"C:\Users\zenit\Downloads\Assignment 1-1.pdf"],
        filetypes=["application/pdf"],
        student_id="student123"
    )
    print("Plagiarism result:")
    print(result)

    # Optional: train model after checks
    train_model_automatic()
