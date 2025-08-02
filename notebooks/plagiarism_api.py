from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import os
import shutil

app = FastAPI()

# Enable CORS
origins = [
    "http://localhost:3000",  # Your frontend URL
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import your existing plagiarism code here:
from plagiarism_pipeline import check_plagiarism

@app.post("/check-plagiarism")
async def check_plagiarism_api(
    files: list[UploadFile] = File(None),
    text_input: str = Form(None),
    student_id: str = Form(...)
):
    filepaths = []
    filetypes = []

    if files:
        for file in files:
            temp_path = f"/tmp/{file.filename}"
            with open(temp_path, "wb") as f:
                shutil.copyfileobj(file.file, f)
            filepaths.append(temp_path)
            filetypes.append(file.content_type)

    result = check_plagiarism_api(
        filepaths=filepaths,
        filetypes=filetypes,
        student_id=student_id,
        text_input=text_input,
        auto_save=True
    )

    for path in filepaths:
        os.remove(path)

    return JSONResponse(content=result)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
