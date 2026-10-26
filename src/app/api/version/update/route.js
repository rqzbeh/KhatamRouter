import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      message: "In-place package update is disabled in KhatamRouter. Please update via container or git pull.",
    },
    { status: 403 }
  );
}

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      message: "In-place package update is disabled in KhatamRouter. Please update via container or git pull.",
    },
    { status: 403 }
  );
}
