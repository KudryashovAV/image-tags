import { NextResponse } from "next/server";
import { fetchAndProcessIssuesData, filterAndAggregateByType } from "../../services/googlePlayVitals";

export const dynamic = "force-dynamic";

export const GET = async () => {
  try {
    const allRawIssues = await fetchAndProcessIssuesData();

    const data = {
      anrs: filterAndAggregateByType(allRawIssues, "APPLICATION_NOT_RESPONDING"),
      crashes: filterAndAggregateByType(allRawIssues, "CRASH"),
    };

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    });
  } catch (error) {
    console.error("Critical error in Vitals GET route:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch and process Vitals data",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
};
