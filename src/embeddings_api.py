# embeddings_api.py

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import os

app = FastAPI()

# Load your fine-tuned model from local directory (adjust path as needed)
MODEL_PATH = "fine_tuned_plagiarism_model"
if not os.path.exists(MODEL_PATH):
    raise Exception(f"Model directory '{MODEL_PATH}' not found. Please save your fine-tuned model first.")

model = SentenceTransformer(MODEL_PATH)

class TextRequest(BaseModel):
    text: str

@app.post("/embed")
async def embed_text(request: TextRequest):
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text must not be empty")
    
    # Generate embedding
    embedding = model.encode(text).tolist()
    
    return {"embedding": embedding}
