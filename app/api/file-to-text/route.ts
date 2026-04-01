import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import pdfParse from "pdf-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

function normalizeExtractedText(value: string) {
  return value.replace(/\r/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractTextFromImage(file: File) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OpenAI API key is not configured on the server.");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const base64 = buffer.toString("base64");
  const dataUrl = `data:${file.type};base64,${base64}`;

  const completion = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content:
          "Extract readable maritime/port intelligence text from the uploaded image. Return plain text only. Preserve line breaks and operational details. Do not summarize.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Extract all readable port, terminal, berth, draft, density, cargo, equipment, rate, restriction, and source text from this image. Return text only.",
          },
          {
            type: "image_url",
            image_url: {
              url: dataUrl,
            },
          },
        ],
      },
    ],
  });

  return normalizeExtractedText(completion.choices[0]?.message?.content ?? "");
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "Expected multipart/form-data with a 'file' field." },
        { status: 400 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "Missing 'file' field in form-data." },
        { status: 400 }
      );
    }

    if (file.size === 0) {
      return NextResponse.json({ error: "Uploaded file is empty." }, { status: 400 });
    }

    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: "File is too large. Please keep uploads under 10 MB." },
        { status: 400 }
      );
    }

    let text = "";

    if (file.type === "application/pdf") {
      const buffer = Buffer.from(await file.arrayBuffer());
      const parsed = await pdfParse(buffer);
      text = normalizeExtractedText(parsed.text || "");
    } else if (IMAGE_TYPES.has(file.type)) {
      text = await extractTextFromImage(file);
    } else {
      return NextResponse.json(
        {
          error:
            "Unsupported file type. Please upload PDF, PNG, JPG, JPEG, or WEBP.",
        },
        { status: 400 }
      );
    }

    if (!text) {
      return NextResponse.json(
        {
          error:
            file.type === "application/pdf"
              ? "Could not extract readable text from this PDF. If it is a scanned PDF, try exporting a page image and uploading PNG/JPG."
              : "Could not extract readable text from this image.",
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        text,
        fileName: file.name,
        mimeType: file.type,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("FILE TO TEXT FATAL ERROR:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Internal error while extracting text from file.",
      },
      { status: 500 }
    );
  }
}
