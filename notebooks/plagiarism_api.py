from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import os
import tempfile

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

    # Save uploaded files as temp files (cross-platform)
    if files:
        for file in files:
            suffix = os.path.splitext(file.filename)[1]
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
                temp_file.write(await file.read())
                temp_path = temp_file.name
            filepaths.append(temp_path)
            filetypes.append(file.content_type)

    # Call your plagiarism checking logic
    result = check_plagiarism(
        filepaths=filepaths,
        filetypes=filetypes,
        student_id=student_id,
        text_input=text_input,
        auto_save=True
    )

    # Clean up the temp files
    for path in filepaths:
        try:
            os.remove(path)
        except Exception as e:
            print(f"Failed to delete temp file {path}: {e}")

    if not isinstance(result, dict):
     result = {"error": "Plagiarism check did not return a valid result."}
    return JSONResponse(content=result)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
