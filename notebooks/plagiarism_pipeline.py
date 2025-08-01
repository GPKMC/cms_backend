# import os
# import re
# import numpy as np
# from pymongo import MongoClient
# from sentence_transformers import SentenceTransformer
# from pdf2image import convert_from_path
# import pytesseract
# from docx import Document
# import textract
# from urllib.parse import urlparse

# # Config
# MONGO_URI = "mongodb+srv://karkibipl:biplovkarki@cmsdatabase.kznvlq9.mongodb.net/"
# DB_NAME = "test"
# MODEL_PATH = "my-finetuned-model"  # Use your fine-tuned model folder
# PLAG_THRESHOLD = 0.3  # 30%

# client = MongoClient(MONGO_URI)
# db = client[DB_NAME]
# model = SentenceTransformer(MODEL_PATH)

# def extract_text_from_file(filepath, filetype):
#     if filetype is None and filepath.lower().endswith('.pdf'):
#         filetype = "application/pdf"
#     try:
#         if filetype and "image" in filetype:
#             return pytesseract.image_to_string(filepath)
#         elif filetype in ["application/pdf", "pdf"]:
#             images = convert_from_path(filepath, poppler_path=r'C:\poppler-24.08.0\Library\bin')
#             return " ".join([pytesseract.image_to_string(img) for img in images])
#         elif filetype in ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"]:
#             doc = Document(filepath)
#             return "\n".join([para.text for para in doc.paragraphs])
#         elif filetype in ["text/plain", "txt"]:
#             with open(filepath, encoding="utf-8") as f:
#                 return f.read()
#         else:
#             return textract.process(filepath).decode("utf-8")
#     except Exception as e:
#         print(f"Could not extract text from {filepath}: {e}")
#         return ""

# def extract_and_store_urls(text):
#     urls = re.findall(r"https?://[^\s]+", text)
#     for url in urls:
#         exists = db.references.find_one({"source_url": url})
#         if not exists:
#             db.references.insert_one({
#                 "type": "website",
#                 "title": urlparse(url).netloc,
#                 "source_url": url,
#                 "text": "",
#                 "embedding": []
#             })

# def embed_text(text):
#     return model.encode(text).tolist()

# def cosine_sim(a, b):
#     a = np.array(a)
#     b = np.array(b)
#     return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-8))

# def flatten_group_submissions(group_assignments):
#     group_subs = []
#     for ga in group_assignments:
#         for group in ga.get("groups", []):
#             for gsub in group.get("submissions", []):
#                 if "embedding" not in gsub:
#                     gsub["embedding"] = []
#                 group_subs.append({
#                     "text": gsub.get("combinedText", ""),
#                     "embedding": gsub.get("embedding", []),
#                     "student": gsub.get("submittedBy"),
#                     "_id": gsub.get("_id")
#                 })
#     return group_subs

# def load_all_pools():
#     submissions = list(db.submissions.find({}))
#     pool_subs = [{
#         "text": sub.get("combinedText", ""),
#         "embedding": sub.get("embedding", []),
#         "student": sub.get("student") or sub.get("submittedBy"),
#         "_id": sub.get("_id")
#     } for sub in submissions]

#     question_submissions = list(db.questionsubmissions.find({}))
#     pool_subs += [{
#         "text": sub.get("answerText", ""),
#         "embedding": sub.get("embedding", []),
#         "student": sub.get("student") or sub.get("submittedBy"),
#         "_id": sub.get("_id")
#     } for sub in question_submissions]

#     group_assignments = list(db.groupassignments.find({}))
#     pool_subs += flatten_group_submissions(group_assignments)

#     references = list(db.references.find({}))
#     pool_refs = [{
#         "text": ref.get("text", ""),
#         "embedding": ref.get("embedding", []),
#         "_id": ref.get("_id")
#     } for ref in references]

#     return pool_subs, pool_refs

# def check_plagiarism(
#     filepaths=None,
#     filetypes=None,
#     student_id=None,
#     text_input=None,
#     auto_save=True
# ):
#     if filepaths is None:
#         filepaths = []
#     if filetypes is None:
#         filetypes = [None] * len(filepaths)

#     all_texts = []
#     for i, filepath in enumerate(filepaths):
#         if os.path.exists(filepath):
#             filetype = filetypes[i] if i < len(filetypes) else None
#             extracted = extract_text_from_file(filepath, filetype)
#             all_texts.append(extracted)
#     if text_input:
#         all_texts.append(text_input)
#     full_text = "\n".join(all_texts).strip()

#     extract_and_store_urls(full_text)

#     if full_text.strip():
#         embedding = embed_text(full_text)
#     else:
#         embedding = []

#     if not embedding or len(embedding) == 0:
#         return {
#             "status": "EMPTY_INPUT",
#             "message": "No text was extracted from the provided files or input.",
#             "plagiarism": 0,
#             "matches": []
#         }

#     pool_subs, pool_refs = load_all_pools()

#     matches = []

#     for other in pool_subs:
#         if student_id and other.get("student") == student_id:
#             continue
#         if other.get("embedding"):
#             sim = cosine_sim(embedding, other["embedding"])
#             if sim > 0:
#                 matches.append({
#                     "type": "submission",
#                     "source_id": str(other["_id"]),
#                     "similarity": sim,
#                     "matched_text": None
#                 })

#     for ref in pool_refs:
#         if ref.get("embedding"):
#             sim = cosine_sim(embedding, ref["embedding"])
#             if sim > 0:
#                 matches.append({
#                     "type": "reference",
#                     "source_id": str(ref["_id"]),
#                     "similarity": sim,
#                     "matched_text": None
#                 })

#     max_sim = max([m["similarity"] for m in matches], default=0)
#     plag_percent = max_sim * 100

#     if plag_percent < PLAG_THRESHOLD * 100:
#         if auto_save and full_text:
#             db.submissions.insert_one({
#                 "student": student_id,
#                 "combinedText": full_text,
#                 "embedding": embedding,
#                 "plagiarismPercentage": plag_percent,
#                 "matches": matches
#             })
#         return {
#             "status": "ACCEPTED",
#             "plagiarism": plag_percent,
#             "matches": matches
#         }
#     else:
#         matches = sorted(matches, key=lambda x: x["similarity"], reverse=True)
#         return {
#             "status": "PLAGIARIZED",
#             "plagiarism": plag_percent,
#             "matches": matches[:10]
#         }

# # Example usage:
# if __name__ == "__main__":
#     # Check a student PDF file
#     result = check_plagiarism(
#         filepaths=[r"C:\Users\zenit\Downloads\Assignment 1-1.pdf"],
#         filetypes=["application/pdf"],
#         student_id="student123"
#     )
#     print(result)

#     # Check direct text input (no files)
#     result2 = check_plagiarism(
#         text_input="This is the content I want to check for plagiarism.",
#         student_id="student456"
#     )
#     print(result2)


import os
import re
import numpy as np
from pymongo import MongoClient
from sentence_transformers import SentenceTransformer
from pdf2image import convert_from_path
from docx import Document
import textract
from urllib.parse import urlparse
from google.cloud import vision

# Set your Google Vision API credentials file path here or set it as an environment variable externally
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = r"c:\Users\zenit\Downloads\winter-rider-437615-e5-1f4432809731.json"

# Config
MONGO_URI = "mongodb+srv://karkibipl:biplovkarki@cmsdatabase.kznvlq9.mongodb.net/"
DB_NAME = "test"
MODEL_PATH = "my-finetuned-model"  # Path to your fine-tuned SentenceTransformer model folder
PLAG_THRESHOLD = 0.3  # 30% plagiarism threshold

# Initialize MongoDB client and model
client = MongoClient(MONGO_URI)
db = client[DB_NAME]
model = SentenceTransformer(MODEL_PATH)

# Initialize Google Vision Client globally
vision_client = vision.ImageAnnotatorClient()

def google_vision_ocr(image_path):
    """Use Google Cloud Vision OCR to extract text from an image file path."""
    with open(image_path, "rb") as image_file:
        content = image_file.read()
    image = vision.Image(content=content)
    response = vision_client.document_text_detection(image=image)
    if response.error.message:
        raise Exception(f'Google Vision API error: {response.error.message}')
    return response.full_text_annotation.text

def extract_text_from_file(filepath, filetype):
    """Extract text from various file types, using Google Vision for images and PDFs."""
    if filetype is None and filepath.lower().endswith('.pdf'):
        filetype = "application/pdf"
    try:
        if filetype and "image" in filetype:
            # For images, use Google Vision OCR
            return google_vision_ocr(filepath)
        elif filetype in ["application/pdf", "pdf"]:
            # Convert PDF pages to images, then OCR each with Google Vision
            images = convert_from_path(filepath, poppler_path=r'C:\poppler-24.08.0\Library\bin')
            texts = []
            for i, image in enumerate(images):
                temp_image_path = f"temp_page_{i}.png"
                image.save(temp_image_path, "PNG")
                text = google_vision_ocr(temp_image_path)
                texts.append(text)
                os.remove(temp_image_path)
            return " ".join(texts)
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

def extract_and_store_urls(text):
    """Extract URLs from text and add new ones to references DB."""
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

def embed_text(text):
    """Get embedding vector for given text using SentenceTransformer model."""
    return model.encode(text).tolist()

def cosine_sim(a, b):
    """Calculate cosine similarity between two embedding vectors."""
    a = np.array(a)
    b = np.array(b)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-8))

def flatten_group_submissions(group_assignments):
    """Extract all group submissions in a flat list."""
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
    """Load all submissions, question submissions, group submissions, and references with embeddings."""
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

def check_plagiarism(
    filepaths=None,
    filetypes=None,
    student_id=None,
    text_input=None,
    auto_save=True
):
    """Main function to check plagiarism for given files or text input."""
    if filepaths is None:
        filepaths = []
    if filetypes is None:
        filetypes = [None] * len(filepaths)

    all_texts = []
    for i, filepath in enumerate(filepaths):
        if os.path.exists(filepath):
            filetype = filetypes[i] if i < len(filetypes) else None
            extracted = extract_text_from_file(filepath, filetype)
            all_texts.append(extracted)
    if text_input:
        all_texts.append(text_input)
    full_text = "\n".join(all_texts).strip()

    extract_and_store_urls(full_text)

    if full_text.strip():
        embedding = embed_text(full_text)
    else:
        embedding = []

    if not embedding or len(embedding) == 0:
        return {
            "status": "EMPTY_INPUT",
            "message": "No text was extracted from the provided files or input.",
            "plagiarism": 0,
            "matches": []
        }

    pool_subs, pool_refs = load_all_pools()

    matches = []

    for other in pool_subs:
        if student_id and other.get("student") == student_id:
            continue
        if other.get("embedding"):
            sim = cosine_sim(embedding, other["embedding"])
            if sim > 0:
                matches.append({
                    "type": "submission",
                    "source_id": str(other["_id"]),
                    "similarity": sim,
                    "matched_text": None
                })

    for ref in pool_refs:
        if ref.get("embedding"):
            sim = cosine_sim(embedding, ref["embedding"])
            if sim > 0:
                matches.append({
                    "type": "reference",
                    "source_id": str(ref["_id"]),
                    "similarity": sim,
                    "matched_text": None
                })

    max_sim = max([m["similarity"] for m in matches], default=0)
    plag_percent = max_sim * 100

    if plag_percent < PLAG_THRESHOLD * 100:
        if auto_save and full_text:
            db.submissions.insert_one({
                "student": student_id,
                "combinedText": full_text,
                "embedding": embedding,
                "plagiarismPercentage": plag_percent,
                "matches": matches
            })
        return {
            "status": "ACCEPTED",
            "plagiarism": plag_percent,
            "matches": matches
        }
    else:
        matches = sorted(matches, key=lambda x: x["similarity"], reverse=True)
        return {
            "status": "PLAGIARIZED",
            "plagiarism": plag_percent,
            "matches": matches[:10]
        }

# Example usage:
if __name__ == "__main__":
    # Check a student PDF file (replace path with your file)
    result = check_plagiarism(
        filepaths=[r"C:\Users\zenit\Downloads\Assignment 1-1.pdf"],
        filetypes=["application/pdf"],
        student_id="student123"
    )
    print(result)

    # Check direct text input (no files)
    result2 = check_plagiarism(
        text_input="This is the content I want to check for plagiarism.",
        student_id="student456"
    )
    print(result2)
