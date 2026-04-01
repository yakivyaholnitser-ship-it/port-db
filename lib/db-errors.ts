import { Prisma } from "@prisma/client";

export function getSchemaMismatchMessage(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2021") {
      return "Database schema is outdated: one of the required tables does not exist yet. Apply the latest Prisma migration first.";
    }

    if (error.code === "P2022") {
      return "Database schema is outdated: one of the required columns does not exist yet. Apply the latest Prisma migration first.";
    }
  }

  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";

  if (/column .* does not exist/i.test(message) || /relation .* does not exist/i.test(message)) {
    return "Database schema is outdated and does not match the current app. Apply the latest Prisma migration first.";
  }

  return null;
}

export function getDatabaseUnavailableMessage(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientInitializationError) {
    if (error.errorCode === "P1001") {
      return "Database is temporarily unreachable. Neon may be waking up or the connection is unstable. Please try again in a few seconds.";
    }
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P1001") {
      return "Database is temporarily unreachable. Neon may be waking up or the connection is unstable. Please try again in a few seconds.";
    }
  }

  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";

  if (
    /can't reach database server/i.test(message) ||
    /database server .* timed out/i.test(message) ||
    (/neon/i.test(message) && /unreachable|timed out|connect|reach/i.test(message))
  ) {
    return "Database is temporarily unreachable. Neon may be waking up or the connection is unstable. Please try again in a few seconds.";
  }

  return null;
}
