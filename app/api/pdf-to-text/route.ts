import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
        { error: "Missing 'file' field (PDF file) in form-data." },
        { status: 400 }
      );
    }

    // Читаем файл как ArrayBuffer и превращаем в Node Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Очень простой "декодер":
    //  - интерпретируем байты как latin1 (1 байт = 1 символ)
    //  - убираем непечатные символы
    const raw = buffer.toString("latin1");

    // Оставляем только печатные символы ASCII + пробелы / переносы строк
    let cleaned = raw
      .replace(/[^\x09\x0A\x0D\x20-\x7E]+/g, " ") // всё "левое" → пробел
      .replace(/\s{2,}/g, " ") // сжать много пробелов
      .trim();

    // Ограничим на всякий случай размер
    if (cleaned.length > 200000) {
      cleaned = cleaned.slice(0, 200000);
    }

    if (!cleaned) {
      return NextResponse.json(
        {
          error:
            "Could not extract any readable text from this PDF. It may be a scanned image or heavily encoded.",
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ text: cleaned }, { status: 200 });
  } catch (err) {
    console.error("PDF TO TEXT FATAL ERROR:", err);
    return NextResponse.json(
      { error: "Internal error while reading PDF." },
      { status: 500 }
    );
  }
}