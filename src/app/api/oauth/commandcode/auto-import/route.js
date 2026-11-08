import { NextResponse } from "next/server";
import { open, constants } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { isLocalRequest } from "@/dashboardGuard";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";

const MAX_AUTH_FILE_SIZE = 64 * 1024; // 64 KiB
const READ_LIMIT = MAX_AUTH_FILE_SIZE + 1; // 64 KiB + 1 byte for bounded oversize detection
const OPEN_FLAGS =
  (constants.O_RDONLY ?? 0) |
  (constants.O_NONBLOCK || 0) |
  (constants.O_NOFOLLOW || 0);

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
};

function getCandidatePaths() {
  const home = homedir();
  const paths = [
    join(home, ".commandcode", "auth.json"),
  ];

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    paths.push(join(appData, "commandcode", "auth.json"));
  }

  return paths;
}

/**
 * GET /api/oauth/commandcode/auto-import
 * Auto-detect Command Code CLI credentials from ~/.commandcode/auth.json
 * Guarded: requires loopback peer and valid dashboard JWT session.
 * Uses bounded descriptor reads to prevent memory exhaustion and TOCTOU issues.
 */
export async function GET(request) {
  try {
    // 1. Guard check: loopback-only (before any fs operations)
    if (!request || !isLocalRequest(request)) {
      return NextResponse.json(
        { found: false, error: "Access denied: loopback access required" },
        { status: 403, headers: NO_STORE_HEADERS }
      );
    }

    // 2. Guard check: valid JWT required (even if requireLogin=false, before any fs operations)
    const token = request.cookies?.get?.("auth_token")?.value;
    const isAuthed = token ? await verifyDashboardAuthToken(token) : false;
    if (!isAuthed) {
      return NextResponse.json(
        { found: false, error: "Unauthorized: valid session token required" },
        { status: 401, headers: NO_STORE_HEADERS }
      );
    }

    // 3. Probing candidate paths using descriptor open with safe flags
    const candidates = getCandidatePaths();

    let handle = null;
    for (const candidate of candidates) {
      try {
        handle = await open(candidate, OPEN_FLAGS);
        break;
      } catch {
        // Continue to next candidate (e.g. ENOENT, ELOOP for symlink with O_NOFOLLOW)
      }
    }

    if (!handle) {
      return NextResponse.json(
        {
          found: false,
          error: "Command Code auth file not found (~/.commandcode/auth.json). Run 'commandcode login' in your terminal first.",
        },
        { status: 200, headers: NO_STORE_HEADERS }
      );
    }

    try {
      // 4. Validate descriptor is a regular file (reject FIFOs, devices, directories)
      const fileStat = await handle.stat();
      if (!fileStat?.isFile?.()) {
        return NextResponse.json(
          { found: false, error: "Command Code auth file is not a regular file" },
          { status: 400, headers: NO_STORE_HEADERS }
        );
      }

      // Pre-check size if reported
      if (typeof fileStat.size === "number" && fileStat.size > MAX_AUTH_FILE_SIZE) {
        return NextResponse.json(
          { found: false, error: "Command Code auth file exceeds size limit" },
          { status: 400, headers: NO_STORE_HEADERS }
        );
      }

      // 5. Bounded loop read: read at most MAX_AUTH_FILE_SIZE + 1 bytes total
      const chunks = [];
      let totalBytes = 0;
      const buffer = Buffer.alloc(Math.min(8192, READ_LIMIT));

      while (totalBytes < READ_LIMIT) {
        const toRead = Math.min(buffer.length, READ_LIMIT - totalBytes);
        const { bytesRead } = await handle.read(buffer, 0, toRead, null);
        if (!bytesRead || bytesRead <= 0) break;
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        totalBytes += bytesRead;
      }

      if (totalBytes > MAX_AUTH_FILE_SIZE) {
        return NextResponse.json(
          { found: false, error: "Command Code auth file exceeds size limit" },
          { status: 400, headers: NO_STORE_HEADERS }
        );
      }

      const raw = Buffer.concat(chunks).toString("utf-8");

      // 6. Validate JSON shape and key types
      let auth;
      try {
        auth = JSON.parse(raw);
      } catch {
        return NextResponse.json(
          {
            found: false,
            error: "Command Code auth file is not valid JSON. Please run 'commandcode login' again.",
          },
          { status: 200, headers: NO_STORE_HEADERS }
        );
      }

      if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
        return NextResponse.json(
          { found: false, error: "Command Code auth file has invalid format." },
          { status: 200, headers: NO_STORE_HEADERS }
        );
      }

      const apiKey = typeof auth.apiKey === "string" ? auth.apiKey.trim() : "";
      if (!apiKey) {
        return NextResponse.json(
          {
            found: false,
            error: "No apiKey found in Command Code auth file. Please run 'commandcode login'.",
          },
          { status: 200, headers: NO_STORE_HEADERS }
        );
      }

      return NextResponse.json(
        {
          found: true,
          apiKey,
          userId: typeof auth.userId === "string" ? auth.userId : null,
          userName: typeof auth.userName === "string" ? auth.userName : null,
          keyName: typeof auth.keyName === "string" ? auth.keyName : null,
          authenticatedAt: typeof auth.authenticatedAt === "string" ? auth.authenticatedAt : null,
        },
        { headers: NO_STORE_HEADERS }
      );
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    // Avoid raw exception / path leaks
    return NextResponse.json(
      { found: false, error: "Failed to read Command Code credentials" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
