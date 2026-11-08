import { NextResponse } from "next/server";
import { readFile, access, constants, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { isLocalRequest } from "@/dashboardGuard";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";

const MAX_AUTH_FILE_SIZE = 64 * 1024; // 64 KiB
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
 */
export async function GET(request) {
  try {
    // 1. Guard check: loopback-only
    if (!request || !isLocalRequest(request)) {
      return NextResponse.json(
        { found: false, error: "Access denied: loopback access required" },
        { status: 403, headers: NO_STORE_HEADERS }
      );
    }

    // 2. Guard check: valid JWT required (even if requireLogin=false)
    const token = request.cookies?.get?.("auth_token")?.value;
    const isAuthed = token ? await verifyDashboardAuthToken(token) : false;
    if (!isAuthed) {
      return NextResponse.json(
        { found: false, error: "Unauthorized: valid session token required" },
        { status: 401, headers: NO_STORE_HEADERS }
      );
    }

    // 3. Probing candidate paths
    const candidates = getCandidatePaths();

    let authPath = null;
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.R_OK);
        authPath = candidate;
        break;
      } catch {
        // try next
      }
    }

    if (!authPath) {
      return NextResponse.json(
        {
          found: false,
          error: "Command Code auth file not found (~/.commandcode/auth.json). Run 'commandcode login' in your terminal first.",
        },
        { status: 200, headers: NO_STORE_HEADERS }
      );
    }

    // 4. Bounded credential read (64 KiB)
    if (typeof stat === "function") {
      try {
        const fileStat = await stat(authPath);
        if (fileStat && fileStat.size > MAX_AUTH_FILE_SIZE) {
          return NextResponse.json(
            { found: false, error: "Command Code auth file exceeds size limit" },
            { status: 400, headers: NO_STORE_HEADERS }
          );
        }
      } catch {
        // Continue to bounded buffer length check
      }
    }

    const raw = await readFile(authPath, "utf-8");
    if (typeof raw === "string" && Buffer.byteLength(raw, "utf-8") > MAX_AUTH_FILE_SIZE) {
      return NextResponse.json(
        { found: false, error: "Command Code auth file exceeds size limit" },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    // 5. Validate JSON shape and key types
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
  } catch {
    // Avoid raw exception / path leaks
    return NextResponse.json(
      { found: false, error: "Failed to read Command Code credentials" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
